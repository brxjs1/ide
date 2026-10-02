//! Ponte com o sidecar do agente (`packages/agent`): um processo Node falando
//! JSON lines em stdin/stdout. Os tipos espelham `packages/agent/src/protocol.ts`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sidecar do agente não encontrado em {0} — rode `pnpm --filter @ide/agent build`")]
    ScriptNotFound(PathBuf),
    #[error("o processo do agente não está rodando")]
    NotRunning,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutonomyMode {
    Plan,
    Assisted,
    Autonomous,
    /// Sem aprovações. Só pode ser enviado com `cwd` dentro de um worktree de tarefa;
    /// quem garante isso é o app (ver `ide_core::tasks::is_task_worktree`).
    Full,
    /// Como `Full`, mas sem ferramentas de edição: para revisar e rodar testes.
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Para continuar uma conversa depois que o app (e o sidecar) reiniciou.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub session_id: String,
    pub cost_total: f64,
}

impl AutonomyMode {
    /// Modos sem aprovação, que só podem rodar dentro de um worktree de tarefa.
    pub fn requires_task_worktree(self) -> bool {
        matches!(self, Self::Full | Self::Review)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inbound {
    Prompt {
        conversation: String,
        id: String,
        text: String,
        cwd: String,
        mode: AutonomyMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<Effort>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<Resume>,
    },
    PermissionResponse {
        id: String,
        allow: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Interrupt {
        conversation: String,
    },
    Reset {
        conversation: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    Init {
        model: String,
        cwd: String,
        #[serde(rename = "permissionMode")]
        permission_mode: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "isError")]
        is_error: bool,
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Outbound {
    Ready,
    Event {
        conversation: String,
        prompt_id: String,
        event: AgentEvent,
    },
    PermissionRequest {
        conversation: String,
        id: String,
        prompt_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    Done {
        conversation: String,
        prompt_id: String,
        session_id: Option<String>,
        is_error: bool,
        cost_usd: Option<f64>,
        #[serde(default)]
        cost_total: Option<f64>,
        duration_ms: Option<f64>,
        result: Option<String>,
    },
    Error {
        conversation: Option<String>,
        prompt_id: Option<String>,
        message: String,
    },
}

/// Como iniciar o sidecar.
#[derive(Debug, Clone)]
pub struct SidecarCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl SidecarCommand {
    /// `node <script>`, procurando o script nesta ordem:
    /// 1. `IDE_AGENT_SCRIPT`;
    /// 2. `<resource_dir>/agent/dist/index.js` — o sidecar empacotado no instalador
    ///    (`scripts/bundle-sidecar.mjs`);
    /// 3. o build local em `packages/agent/dist` (desenvolvimento).
    ///
    /// O Node vem de `IDE_NODE` ou do PATH.
    pub fn locate(resource_dir: Option<&Path>) -> Result<Self> {
        let candidates = [
            std::env::var_os("IDE_AGENT_SCRIPT").map(PathBuf::from),
            resource_dir.map(|dir| dir.join("agent/dist/index.js")),
            Some(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../packages/agent/dist/index.js"),
            ),
        ];
        // Variável definida mas apontando para nada é erro, não fallback silencioso.
        if let Some(explicit) = &candidates[0] {
            if !explicit.is_file() {
                return Err(Error::ScriptNotFound(explicit.clone()));
            }
        }
        let script = candidates
            .iter()
            .flatten()
            .find(|p| p.is_file())
            .cloned()
            .ok_or_else(|| {
                Error::ScriptNotFound(candidates.into_iter().flatten().last().unwrap_or_default())
            })?;
        Ok(Self {
            program: std::env::var("IDE_NODE").unwrap_or_else(|_| "node".into()),
            args: vec![script.to_string_lossy().into_owned()],
        })
    }
}

pub struct AgentProcess {
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

impl AgentProcess {
    /// Inicia o sidecar. `on_message` recebe cada linha de stdout já tipada (linhas
    /// inválidas viram `Outbound::Error`); `on_exit` é chamado quando stdout fecha.
    pub fn spawn(
        command: &SidecarCommand,
        mut on_message: impl FnMut(Outbound) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<Self> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or(Error::NotRunning)?;
        let child = Arc::new(Mutex::new(child));

        let waiter = Arc::clone(&child);
        std::thread::Builder::new()
            .name("agent-stdout".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    on_message(
                        serde_json::from_str(&line).unwrap_or_else(|e| Outbound::Error {
                            conversation: None,
                            prompt_id: None,
                            message: format!("mensagem inválida do agente ({e}): {line}"),
                        }),
                    );
                }
                // try_wait em vez de wait: não segura o lock enquanto espera, então
                // stop() consegue matar um processo que fechou stdout mas seguiu vivo.
                let code = loop {
                    match waiter.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
                        Ok(Some(status)) => break status.code(),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                };
                on_exit(code);
            })?;

        Ok(Self {
            stdin: Mutex::new(stdin),
            child,
        })
    }

    pub fn send(&self, message: &Inbound) -> Result<()> {
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let pipe = stdin.as_mut().ok_or(Error::NotRunning)?;
        pipe.write_all(&line)?;
        pipe.flush()?;
        Ok(())
    }

    /// Fecha stdin (o sidecar sai sozinho) e garante o encerramento.
    pub fn stop(&self) {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    #[test]
    fn serializa_inbound_no_formato_do_sidecar() {
        let prompt = Inbound::Prompt {
            conversation: "main".into(),
            id: "p1".into(),
            text: "oi".into(),
            cwd: "/p".into(),
            mode: AutonomyMode::Full,
            model: None,
            effort: Some(Effort::Xhigh),
            resume: Some(Resume {
                session_id: "s".into(),
                cost_total: 0.5,
            }),
        };
        assert_eq!(
            serde_json::to_value(&prompt).unwrap(),
            json!({
                "type": "prompt", "conversation": "main", "id": "p1", "text": "oi", "cwd": "/p",
                "mode": "full", "effort": "xhigh", "resume": {"sessionId": "s", "costTotal": 0.5}
            })
        );
        assert_eq!(
            serde_json::to_value(Inbound::Interrupt {
                conversation: "task:x".into()
            })
            .unwrap(),
            json!({"type": "interrupt", "conversation": "task:x"})
        );
    }

    #[test]
    fn so_full_e_review_exigem_worktree_de_tarefa() {
        let modes = [
            AutonomyMode::Plan,
            AutonomyMode::Assisted,
            AutonomyMode::Autonomous,
            AutonomyMode::Full,
            AutonomyMode::Review,
        ];
        let gated: Vec<_> = modes
            .iter()
            .filter(|m| m.requires_task_worktree())
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        assert_eq!(gated, [json!("full"), json!("review")]);
    }

    #[test]
    fn interpreta_outbound_do_sidecar() {
        let event: Outbound = serde_json::from_value(json!({
            "type": "event", "conversation": "main", "promptId": "p1",
            "event": {"kind": "tool_result", "toolUseId": "t1", "isError": false, "content": "ok"}
        }))
        .unwrap();
        assert_eq!(
            event,
            Outbound::Event {
                conversation: "main".into(),
                prompt_id: "p1".into(),
                event: AgentEvent::ToolResult {
                    tool_use_id: "t1".into(),
                    is_error: false,
                    content: "ok".into()
                }
            }
        );

        let done: Outbound = serde_json::from_value(json!({
            "type": "done", "conversation": "main", "promptId": "p1", "sessionId": null, "isError": false,
            "costUsd": 0.5, "durationMs": 10, "result": "fim"
        }))
        .unwrap();
        assert!(matches!(done, Outbound::Done { cost_usd: Some(c), .. } if c == 0.5));
    }

    #[test]
    fn encontra_sidecar_empacotado_nos_recursos() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent/dist/index.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();

        // Sem IDE_AGENT_SCRIPT (não definida nos testes), os recursos têm prioridade.
        if std::env::var_os("IDE_AGENT_SCRIPT").is_none() {
            let cmd = SidecarCommand::locate(Some(dir.path())).unwrap();
            assert_eq!(cmd.args, [script.to_string_lossy()]);
        }
    }

    /// Sidecar falso em Node: responde a cada prompt com um texto e um done.
    const FAKE: &str = r#"
        const rl = require("readline").createInterface({ input: process.stdin });
        const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
        out({ type: "ready" });
        rl.on("line", (l) => {
          const m = JSON.parse(l);
          out({ type: "event", conversation: m.conversation, promptId: m.id, event: { kind: "text", text: "eco: " + m.text } });
          out({ type: "done", conversation: m.conversation, promptId: m.id, sessionId: "s", isError: false, costUsd: null, durationMs: null, result: null });
          console.log("não é json");
        });
    "#;

    #[test]
    fn conversa_com_processo_real() {
        let (tx, rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let agent = AgentProcess::spawn(
            &SidecarCommand {
                program: "node".into(),
                args: vec!["-e".into(), FAKE.into()],
            },
            move |m| tx.send(m).unwrap(),
            move |code| exit_tx.send(code).unwrap(),
        )
        .unwrap();

        let next = || rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(next(), Outbound::Ready);

        agent
            .send(&Inbound::Prompt {
                conversation: "main".into(),
                id: "p1".into(),
                text: "oi".into(),
                cwd: "/".into(),
                mode: AutonomyMode::Plan,
                model: None,
                effort: None,
                resume: None,
            })
            .unwrap();
        assert_eq!(
            next(),
            Outbound::Event {
                conversation: "main".into(),
                prompt_id: "p1".into(),
                event: AgentEvent::Text {
                    text: "eco: oi".into()
                }
            }
        );
        assert!(matches!(next(), Outbound::Done { prompt_id, .. } if prompt_id == "p1"));
        assert!(
            matches!(next(), Outbound::Error { message, .. } if message.contains("não é json"))
        );

        agent.stop();
        exit_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(
            agent.send(&Inbound::Reset {
                conversation: "main".into()
            }),
            Err(Error::NotRunning)
        ));
    }
}
