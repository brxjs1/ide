//! Terminais reais (PTY). Cada sessão tem uma thread de leitura que entrega a saída
//! em bytes brutos — o frontend (xterm.js) cuida de UTF-8 e sequências ANSI.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("terminal {0} não existe")]
    NotFound(u32),
    #[error("pty: {0}")]
    Pty(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// `None` abre o shell padrão do usuário.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub rows: u16,
    pub cols: u16,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: AtomicU32,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inicia um processo em um PTY novo. `on_output` recebe a saída em pedaços;
    /// `on_exit` é chamado uma vez, depois de toda a saída, com o código de saída.
    pub fn spawn(
        &self,
        options: SpawnOptions,
        mut on_output: impl FnMut(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32> {
        let pair = native_pty_system()
            .openpty(size(options.rows, options.cols))
            .map_err(pty_err)?;

        let mut cmd = match &options.program {
            Some(program) => CommandBuilder::new(program),
            None => CommandBuilder::new(default_shell()),
        };
        cmd.args(&options.args);
        if let Some(cwd) = &options.cwd {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let mut child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
        // Sem o slave aberto no nosso processo, o reader recebe EOF quando o filho sai.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
        let writer = pair.master.take_writer().map_err(pty_err)?;
        let killer = child.clone_killer();

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(
            id,
            Session {
                master: pair.master,
                writer,
                killer,
            },
        );

        let sessions = Arc::clone(&self.sessions);
        std::thread::Builder::new()
            .name(format!("pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => on_output(buf[..n].to_vec()),
                    }
                }
                sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
                on_exit(code);
            })?;

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<()> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(&id).ok_or(Error::NotFound(id))?;
        session.writer.write_all(data)?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<()> {
        let sessions = self.lock();
        let session = sessions.get(&id).ok_or(Error::NotFound(id))?;
        session.master.resize(size(rows, cols)).map_err(pty_err)
    }

    /// Encerra o processo; `on_exit` ainda é chamado pela thread de leitura.
    pub fn kill(&self, id: u32) -> Result<()> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(&id).ok_or(Error::NotFound(id))?;
        session.killer.kill()?;
        Ok(())
    }

    pub fn ids(&self) -> Vec<u32> {
        let mut ids: Vec<_> = self.lock().keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        for session in self.lock().values_mut() {
            let _ = session.killer.kill();
        }
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

fn pty_err(e: impl std::fmt::Display) -> Error {
    Error::Pty(e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    enum Ev {
        Out(Vec<u8>),
        Exit(u32),
    }

    fn spawn(pty: &PtyManager, program: &str, args: &[&str]) -> (u32, mpsc::Receiver<Ev>) {
        let (tx, rx) = mpsc::channel();
        let tx_exit = tx.clone();
        let id = pty
            .spawn(
                SpawnOptions {
                    program: Some(program.into()),
                    args: args.iter().map(|a| a.to_string()).collect(),
                    rows: 24,
                    cols: 80,
                    ..Default::default()
                },
                move |b| {
                    let _ = tx.send(Ev::Out(b));
                },
                move |c| {
                    let _ = tx_exit.send(Ev::Exit(c));
                },
            )
            .unwrap();
        (id, rx)
    }

    /// Lê eventos até a saída conter `needle` (ou até o processo sair, se `needle` for vazio).
    fn read_until(rx: &mpsc::Receiver<Ev>, needle: &str) -> (String, Option<u32>) {
        let mut out = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("timeout") {
                Ev::Out(b) => {
                    out.extend(b);
                    let text = String::from_utf8_lossy(&out).into_owned();
                    if !needle.is_empty() && text.contains(needle) {
                        return (text, None);
                    }
                }
                Ev::Exit(code) => return (String::from_utf8_lossy(&out).into_owned(), Some(code)),
            }
        }
    }

    #[test]
    fn captura_saida_e_codigo() {
        let pty = PtyManager::new();
        let (id, rx) = spawn(&pty, "sh", &["-c", "printf 'olá'; exit 3"]);
        let (out, code) = read_until(&rx, "");
        assert!(out.contains("olá"), "saída: {out:?}");
        assert_eq!(code, Some(3));
        assert!(matches!(pty.write(id, b"x"), Err(Error::NotFound(_))));
    }

    #[test]
    fn escreve_redimensiona_e_encerra() {
        let pty = PtyManager::new();
        let (id, rx) = spawn(&pty, "cat", &[]);
        pty.resize(id, 40, 120).unwrap();
        pty.write(id, b"eco\n").unwrap();
        read_until(&rx, "eco");
        assert_eq!(pty.ids(), [id]);

        pty.kill(id).unwrap();
        let (_, code) = read_until(&rx, "");
        assert!(code.is_some());
        assert!(pty.ids().is_empty());
    }

    #[test]
    fn id_inexistente() {
        let pty = PtyManager::new();
        assert!(matches!(pty.resize(99, 1, 1), Err(Error::NotFound(99))));
        assert!(matches!(pty.kill(99), Err(Error::NotFound(99))));
    }
}
