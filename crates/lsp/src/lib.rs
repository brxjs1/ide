//! Cliente LSP mínimo e sem async: um processo por linguagem, JSON-RPC com cabeçalho
//! `Content-Length` em stdin/stdout, uma thread de leitura que entrega respostas às
//! requisições pendentes e notificações (diagnósticos) a um callback.
//!
//! Posições seguem o LSP: linha e caractere a partir de 0, em unidades UTF-16 — o mesmo
//! que o JavaScript usa, então o editor só converte de 1 para 0.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("servidor de linguagem indisponível: {0} (instale-o e reabra o arquivo)")]
    NotInstalled(String),
    #[error("o servidor de linguagem encerrou")]
    Closed,
    #[error("o servidor de linguagem não respondeu a {0} a tempo")]
    Timeout(String),
    #[error("erro do servidor de linguagem: {0}")]
    Server(String),
    #[error("caminho inválido: {0}")]
    Path(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Como iniciar o servidor de uma linguagem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSpec {
    /// Chave do servidor (um processo por chave).
    pub key: &'static str,
    pub command: String,
    pub args: Vec<String>,
}

/// Servidor e `languageId` padrão para um arquivo, pela extensão.
pub fn spec_for(path: &Path) -> Option<(ServerSpec, &'static str)> {
    let ext = path.extension()?.to_str()?;
    let spec = |key, command: &str, args: &[&str]| ServerSpec {
        key,
        command: command.to_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
    };
    Some(match ext {
        "rs" => (spec("rust", "rust-analyzer", &[]), "rust"),
        "ts" | "mts" | "cts" => (
            spec("ts", "typescript-language-server", &["--stdio"]),
            "typescript",
        ),
        "tsx" => (
            spec("ts", "typescript-language-server", &["--stdio"]),
            "typescriptreact",
        ),
        "js" | "mjs" | "cjs" => (
            spec("ts", "typescript-language-server", &["--stdio"]),
            "javascript",
        ),
        "jsx" => (
            spec("ts", "typescript-language-server", &["--stdio"]),
            "javascriptreact",
        ),
        "py" => (spec("python", "pyright-langserver", &["--stdio"]), "python"),
        "go" => (spec("go", "gopls", &[]), "go"),
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub range: Range,
    /// 1 erro, 2 aviso, 3 informação, 4 dica.
    pub severity: u8,
    pub message: String,
    pub source: Option<String>,
    /// Código do erro no servidor (`2322` do TypeScript, `E0308` do Rust...), para o
    /// editor explicar o que aconteceu e como resolver.
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: PathBuf,
    pub range: Range,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<std::result::Result<Value, String>>>>>;

/// Teto de uma mensagem do servidor: protege contra um `Content-Length` absurdo.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub struct LspClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    /// Desligado quando a thread de leitura termina (processo morreu ou stdout quebrou).
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
    pending: Pending,
    timeout: Duration,
}

impl LspClient {
    /// Inicia o servidor e faz o handshake `initialize`/`initialized`.
    /// `on_notification(método, params)` recebe as notificações do servidor.
    pub fn start(
        spec: &ServerSpec,
        root: &Path,
        on_notification: impl Fn(&str, Value) + Send + 'static,
    ) -> Result<Self> {
        let mut child = Command::new(&spec.command)
            .args(&spec.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => Error::NotInstalled(spec.command.clone()),
                _ => Error::Io(e),
            })?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or(Error::Closed)?));
        let stdout = child.stdout.take().ok_or(Error::Closed)?;
        let pending: Pending = Arc::default();

        let child = Arc::new(Mutex::new(child));
        let alive = Arc::new(AtomicBool::new(true));

        let reader_pending = Arc::clone(&pending);
        let reader_stdin = Arc::clone(&stdin);
        let reader_child = Arc::clone(&child);
        let reader_alive = Arc::clone(&alive);
        std::thread::Builder::new()
            .name(format!("lsp-{}", spec.key))
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_message(&mut reader) {
                        Ok(Some(message)) => {
                            dispatch(message, &reader_pending, &reader_stdin, &on_notification)
                        }
                        // Mensagem malformada (já consumida): descarta e segue.
                        Err(Error::Json(_)) | Err(Error::Server(_)) => continue,
                        Ok(None) | Err(_) => break,
                    }
                }
                // Sem leitura não há como conversar: encerra o processo (senão o pipe enche
                // e ele trava) e quem espera resposta recebe erro em vez de esperar o timeout.
                reader_alive.store(false, Ordering::SeqCst);
                {
                    let mut child = lock(&reader_child);
                    let _ = child.kill();
                    let _ = child.wait();
                }
                for (_, tx) in lock(&reader_pending).drain() {
                    let _ = tx.send(Err("encerrado".into()));
                }
            })?;

        let client = Self {
            stdin,
            child,
            alive,
            next_id: AtomicU64::new(1),
            pending,
            timeout: Duration::from_secs(60),
        };
        let root_uri = uri(root)?;
        client.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "root" }],
                "capabilities": {
                    "general": { "positionEncodings": ["utf-16"] },
                    "textDocument": {
                        "synchronization": { "didSave": true },
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "definition": { "linkSupport": false },
                        "publishDiagnostics": { "relatedInformation": false }
                    },
                    "workspace": { "configuration": true, "workspaceFolders": true }
                }
            }),
        )?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    /// O processo ainda está respondendo? Um cliente morto deve ser substituído.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, self.timeout)
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        if let Err(e) = send(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        ) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) if message == "encerrado" => Err(Error::Closed),
            Ok(Err(message)) => Err(Error::Server(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                Err(Error::Timeout(method.to_owned()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::Closed),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        send(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
    }

    pub fn did_open(&self, path: &Path, language_id: &str, version: i32, text: &str) -> Result<()> {
        self.notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri(path)?, "languageId": language_id, "version": version, "text": text } }),
        )
    }

    /// Sincronização completa (o documento inteiro a cada mudança): simples e suficiente.
    pub fn did_change(&self, path: &Path, version: i32, text: &str) -> Result<()> {
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri(path)?, "version": version },
                "contentChanges": [{ "text": text }]
            }),
        )
    }

    /// Avisa que o arquivo foi salvo: o rust-analyzer só refaz o `cargo check` (e os
    /// diagnósticos do compilador) ao receber isto.
    pub fn did_save(&self, path: &Path, text: &str) -> Result<()> {
        self.notify(
            "textDocument/didSave",
            json!({ "textDocument": { "uri": uri(path)? }, "text": text }),
        )
    }

    pub fn did_close(&self, path: &Path) -> Result<()> {
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri(path)? } }),
        )
    }

    /// Texto do hover em markdown (`None` se não há nada na posição).
    pub fn hover(&self, path: &Path, pos: Position) -> Result<Option<String>> {
        let result = self.request(
            "textDocument/hover",
            json!({ "textDocument": { "uri": uri(path)? }, "position": pos }),
        )?;
        Ok(hover_text(&result["contents"]).filter(|t| !t.trim().is_empty()))
    }

    pub fn definition(&self, path: &Path, pos: Position) -> Result<Vec<Location>> {
        let result = self.request(
            "textDocument/definition",
            json!({ "textDocument": { "uri": uri(path)? }, "position": pos }),
        )?;
        let items = match result {
            Value::Array(items) => items,
            Value::Null => Vec::new(),
            single => vec![single],
        };
        Ok(items.iter().filter_map(parse_location).collect())
    }

    /// Encerramento educado; mata o processo se ele não sair. Curto de propósito: roda ao
    /// fechar o app, e um servidor ocupado não pode segurar a saída.
    pub fn shutdown(&self) {
        let _ = self.request_with_timeout("shutdown", Value::Null, Duration::from_secs(2));
        let _ = self.notify("exit", Value::Null);
        let mut child = lock(&self.child);
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Mensagem do servidor: resposta, pedido do servidor ou notificação.
fn dispatch(
    message: Value,
    pending: &Pending,
    stdin: &Arc<Mutex<ChildStdin>>,
    on_notification: &impl Fn(&str, Value),
) {
    let method = message.get("method").and_then(Value::as_str);
    match (message.get("id"), method) {
        // Resposta a uma requisição nossa.
        (Some(id), None) => {
            let Some(id) = id.as_u64() else { return };
            if let Some(tx) = lock(pending).remove(&id) {
                let result = match message.get("error") {
                    Some(err) => Err(err["message"].as_str().unwrap_or("erro").to_owned()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
        }
        // Pedido do servidor (configuração, progresso...): resposta neutra.
        (Some(id), Some(method)) => {
            let result = match method {
                "workspace/configuration" => {
                    let n = message["params"]["items"].as_array().map_or(0, Vec::len);
                    Value::Array(vec![Value::Null; n])
                }
                _ => Value::Null,
            };
            let _ = send(
                stdin,
                &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            );
        }
        (None, Some(method)) => on_notification(
            method,
            message.get("params").cloned().unwrap_or(Value::Null),
        ),
        (None, None) => {}
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length.ok_or_else(|| Error::Server("mensagem sem Content-Length".into()))?;
    if length > MAX_MESSAGE_BYTES {
        // Não dá para pular o corpo com segurança: trata como fluxo corrompido.
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("mensagem de {length} bytes"),
        )));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn send(stdin: &Mutex<ChildStdin>, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    let mut stdin = lock(stdin);
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
    stdin.write_all(&body)?;
    stdin.flush()?;
    Ok(())
}

pub fn uri(path: &Path) -> Result<String> {
    url::Url::from_file_path(path)
        .map(|u| u.to_string())
        .map_err(|_| Error::Path(path.display().to_string()))
}

pub fn path_from_uri(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

fn parse_range(value: &Value) -> Option<Range> {
    let pos = |v: &Value| {
        Some(Position {
            line: v["line"].as_u64()? as u32,
            character: v["character"].as_u64()? as u32,
        })
    };
    Some(Range {
        start: pos(&value["start"])?,
        end: pos(&value["end"])?,
    })
}

fn parse_location(value: &Value) -> Option<Location> {
    // Location { uri, range } ou LocationLink { targetUri, targetSelectionRange }.
    let (uri, range) = match value.get("targetUri") {
        Some(target) => (target, &value["targetSelectionRange"]),
        None => (&value["uri"], &value["range"]),
    };
    Some(Location {
        path: path_from_uri(uri.as_str()?)?,
        range: parse_range(range)?,
    })
}

/// Diagnósticos de uma notificação `textDocument/publishDiagnostics`.
pub fn parse_diagnostics(params: &Value) -> Option<(PathBuf, Vec<Diagnostic>)> {
    let path = path_from_uri(params["uri"].as_str()?)?;
    let items = params["diagnostics"].as_array()?;
    let diagnostics = items
        .iter()
        .filter_map(|d| {
            Some(Diagnostic {
                range: parse_range(&d["range"])?,
                severity: d["severity"].as_u64().unwrap_or(1) as u8,
                message: d["message"].as_str()?.to_owned(),
                source: d["source"].as_str().map(str::to_owned),
                // O LSP manda número ou texto.
                code: match &d["code"] {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                },
            })
        })
        .collect();
    Some((path, diagnostics))
}

/// Hover pode vir como MarkupContent, MarkedString ou lista de MarkedString.
fn hover_text(contents: &Value) -> Option<String> {
    match contents {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<_> = items.iter().filter_map(hover_text).collect();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        }
        Value::Object(obj) => {
            let value = obj.get("value")?.as_str()?;
            Some(match obj.get("language").and_then(Value::as_str) {
                Some(lang) => format!("```{lang}\n{value}\n```"),
                None => value.to_owned(),
            })
        }
        _ => None,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Document {
    server: usize,
    version: i32,
    text: String,
}

/// Servidores do projeto, um por linguagem, iniciados na primeira vez que são usados.
pub struct LspManager {
    root: PathBuf,
    servers: Mutex<HashMap<&'static str, Arc<LspClient>>>,
    /// Um lock por servidor durante a inicialização: subir o rust-analyzer (que pode levar
    /// segundos) não bloqueia as outras linguagens.
    starting: Mutex<HashMap<&'static str, Arc<Mutex<()>>>>,
    /// Documentos abertos pelo editor: servidor que os recebeu, versão e texto. Se o servidor
    /// for substituído (morreu), o documento é reaberto no novo na próxima mudança.
    documents: Mutex<HashMap<PathBuf, Document>>,
    /// Servidores que não estão instalados: não tenta de novo a cada arquivo aberto.
    missing: Mutex<HashMap<&'static str, String>>,
    on_diagnostics: Arc<dyn Fn(PathBuf, Vec<Diagnostic>) + Send + Sync>,
    /// Um único servidor para todos os arquivos, no lugar de [`spec_for`] (testes).
    spec_override: Option<(ServerSpec, &'static str)>,
}

impl LspManager {
    pub fn new(
        root: PathBuf,
        on_diagnostics: impl Fn(PathBuf, Vec<Diagnostic>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            root,
            servers: Mutex::default(),
            starting: Mutex::default(),
            documents: Mutex::default(),
            missing: Mutex::default(),
            on_diagnostics: Arc::new(on_diagnostics),
            spec_override: None,
        }
    }

    /// Como [`LspManager::new`], com o mesmo servidor para qualquer arquivo.
    pub fn with_spec(
        root: PathBuf,
        spec: ServerSpec,
        language_id: &'static str,
        on_diagnostics: impl Fn(PathBuf, Vec<Diagnostic>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            spec_override: Some((spec, language_id)),
            ..Self::new(root, on_diagnostics)
        }
    }

    fn spec(&self, path: &Path) -> Option<(ServerSpec, &'static str)> {
        match &self.spec_override {
            Some(fixed) => Some(fixed.clone()),
            None => spec_for(path),
        }
    }

    /// Cliente para o arquivo, iniciando o servidor se preciso. `Ok(None)` se a linguagem
    /// não tem servidor configurado.
    pub fn client_for(&self, path: &Path) -> Result<Option<(Arc<LspClient>, &'static str)>> {
        self.client_with(path, self.spec(path))
    }

    /// Como [`client_for`], com o servidor escolhido por quem chama (testes, config).
    pub fn client_with(
        &self,
        _path: &Path,
        spec: Option<(ServerSpec, &'static str)>,
    ) -> Result<Option<(Arc<LspClient>, &'static str)>> {
        let Some((spec, language_id)) = spec else {
            return Ok(None);
        };
        if let Some(command) = lock(&self.missing).get(spec.key) {
            return Err(Error::NotInstalled(command.clone()));
        }
        if let Some(client) = self.running(spec.key) {
            return Ok(Some((client, language_id)));
        }
        let gate = Arc::clone(lock(&self.starting).entry(spec.key).or_default());
        let _starting = lock(&gate);
        // Outra thread pode ter iniciado enquanto esperávamos.
        if let Some(client) = self.running(spec.key) {
            return Ok(Some((client, language_id)));
        }
        let on_diagnostics = Arc::clone(&self.on_diagnostics);
        let client = LspClient::start(&spec, &self.root, move |method, params| {
            if method == "textDocument/publishDiagnostics" {
                if let Some((path, diagnostics)) = parse_diagnostics(&params) {
                    on_diagnostics(path, diagnostics);
                }
            }
        });
        match client {
            Ok(client) => {
                let client = Arc::new(client);
                lock(&self.servers).insert(spec.key, Arc::clone(&client));
                Ok(Some((client, language_id)))
            }
            Err(Error::NotInstalled(command)) => {
                lock(&self.missing).insert(spec.key, command.clone());
                Err(Error::NotInstalled(command))
            }
            Err(e) => Err(e),
        }
    }

    /// Abre o documento no servidor da linguagem. `Ok(false)` se não há servidor para ela.
    pub fn open_document(&self, path: &Path, text: &str) -> Result<bool> {
        let Some((client, lang)) = self.client_for(path)? else {
            return Ok(false);
        };
        client.did_open(path, lang, 1, text)?;
        lock(&self.documents).insert(
            path.to_path_buf(),
            Document {
                server: Arc::as_ptr(&client) as usize,
                version: 1,
                text: text.to_owned(),
            },
        );
        Ok(true)
    }

    /// Texto novo do documento. Versões fora de ordem (mais antigas que a última enviada)
    /// são descartadas; se o servidor foi reiniciado, o documento é reaberto nele.
    pub fn change_document(&self, path: &Path, version: i32, text: &str) -> Result<()> {
        let Some((client, lang)) = self.client_for(path)? else {
            return Ok(());
        };
        let server = Arc::as_ptr(&client) as usize;
        let mut documents = lock(&self.documents);
        let Some(doc) = documents.get_mut(path) else {
            return Ok(()); // fechado enquanto a mudança estava a caminho
        };
        if doc.server != server {
            client.did_open(path, lang, version, text)?;
            doc.server = server;
        } else if version <= doc.version {
            return Ok(());
        } else {
            client.did_change(path, version, text)?;
        }
        doc.version = version;
        doc.text = text.to_owned();
        Ok(())
    }

    /// Documento gravado em disco: o servidor refaz a checagem (o `cargo check` do
    /// rust-analyzer só roda aqui).
    pub fn save_document(&self, path: &Path, text: &str) -> Result<()> {
        let Some((client, lang)) = self.client_for(path)? else {
            return Ok(());
        };
        let server = Arc::as_ptr(&client) as usize;
        let mut documents = lock(&self.documents);
        if let Some(doc) = documents.get_mut(path) {
            if doc.server != server {
                client.did_open(path, lang, doc.version, &doc.text)?;
                doc.server = server;
            }
        }
        client.did_save(path, text)
    }

    pub fn close_document(&self, path: &Path) -> Result<()> {
        let Some(doc) = lock(&self.documents).remove(path) else {
            return Ok(());
        };
        match self.running_for(path) {
            Some(client) if Arc::as_ptr(&client) as usize == doc.server => client.did_close(path),
            _ => Ok(()),
        }
    }

    fn running_for(&self, path: &Path) -> Option<Arc<LspClient>> {
        self.running(self.spec(path)?.0.key)
    }

    /// Servidor vivo para a chave; um que morreu é descartado (o próximo uso inicia outro).
    fn running(&self, key: &'static str) -> Option<Arc<LspClient>> {
        let mut servers = lock(&self.servers);
        match servers.get(key) {
            Some(client) if client.is_alive() => Some(Arc::clone(client)),
            Some(_) => {
                servers.remove(key);
                None
            }
            None => None,
        }
    }

    pub fn shutdown(&self) {
        let servers: Vec<_> = lock(&self.servers).drain().collect();
        for (_, client) in servers {
            client.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Servidor LSP falso: responde initialize/hover/definition, pede configuração ao
    /// cliente e publica um diagnóstico ao abrir um documento.
    const FAKE: &str = r#"
let buf = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`); process.stdout.write(b); };
let configured = false; const texts = {};
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n"); if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const m = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString()); buf = buf.slice(sep + 4 + len);
    if (m.id !== undefined && m.method === undefined) { configured = Array.isArray(m.result); continue; }
    switch (m.method) {
      case "initialize": send({ jsonrpc: "2.0", id: m.id, result: { capabilities: { hoverProvider: true } } }); break;
      case "initialized": send({ jsonrpc: "2.0", id: 99, method: "workspace/configuration", params: { items: [{}, {}] } }); break;
      case "textDocument/didSave":
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m.params.textDocument.uri, diagnostics: [] } });
        break;
      case "textDocument/didChange": texts[m.params.textDocument.uri] = m.params.contentChanges[0].text; break;
      case "texto": send({ jsonrpc: "2.0", id: m.id, result: texts[m.params.uri] ?? null }); break;
      case "textDocument/didOpen": texts[m.params.textDocument.uri] = m.params.textDocument.text;
        send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m.params.textDocument.uri,
          diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, severity: 2, message: "não usado", source: "fake", code: 6133 }] } });
        break;
      case "textDocument/hover":
        send({ jsonrpc: "2.0", id: m.id, result: { contents: { kind: "markdown", value: `linha ${m.params.position.line} cfg=${configured}` } } }); break;
      case "textDocument/definition":
        send({ jsonrpc: "2.0", id: m.id, result: [{ targetUri: m.params.textDocument.uri,
          targetSelectionRange: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } }] }); break;
      case "boom": send({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "falhou" } }); break;
      case "lixo": process.stdout.write("Content-Length: 5\r\n\r\n{nao}"); process.stdout.write("X-Sem-Tamanho: 1\r\n\r\n");
        send({ jsonrpc: "2.0", id: m.id, result: "depois do lixo" }); break;
      case "morre": process.exit(3);
      case "shutdown": send({ jsonrpc: "2.0", id: m.id, result: null }); break;
      case "exit": process.exit(0);
    }
  }
});
"#;

    fn fake_spec() -> ServerSpec {
        ServerSpec {
            key: "fake",
            command: "node".into(),
            args: vec!["-e".into(), FAKE.into()],
        }
    }

    #[test]
    fn hover_definicao_diagnosticos_e_pedidos_do_servidor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("main.rs");
        std::fs::write(&file, "fn main() {\n  let x = 1;\n}\n").unwrap();

        let (tx, rx) = mpsc::channel();
        let manager = LspManager::new(root.clone(), move |path, diags| {
            let _ = tx.send((path, diags));
        });
        let (client, lang) = manager
            .client_with(&file, Some((fake_spec(), "rust")))
            .unwrap()
            .unwrap();
        assert_eq!(lang, "rust");

        client.did_open(&file, lang, 1, "fn main() {}").unwrap();
        let (path, diags) = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(path, file);
        assert_eq!(diags[0].message, "não usado");
        assert_eq!(diags[0].severity, 2);
        assert_eq!(diags[0].range.start.character, 2);
        assert_eq!(
            diags[0].code.as_deref(),
            Some("6133"),
            "código numérico vira texto"
        );

        // Salvar reanalisa: o falso publica a lista vazia.
        client.did_save(&file, "fn main() {}").unwrap();
        let (_, diags) = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(diags.is_empty());

        // O cliente respondeu ao workspace/configuration com uma lista.
        let hover = client
            .hover(
                &file,
                Position {
                    line: 4,
                    character: 0,
                },
            )
            .unwrap();
        assert_eq!(hover.as_deref(), Some("linha 4 cfg=true"));

        let defs = client
            .definition(
                &file,
                Position {
                    line: 0,
                    character: 0,
                },
            )
            .unwrap();
        assert_eq!(defs[0].path, file);
        assert_eq!(defs[0].range.start.character, 3);

        assert!(
            matches!(client.request("boom", Value::Null), Err(Error::Server(m)) if m == "falhou")
        );

        // Mesmo servidor na segunda vez.
        let (again, _) = manager
            .client_with(&file, Some((fake_spec(), "rust")))
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&client, &again));
        manager.shutdown();
    }

    #[test]
    fn mensagem_malformada_e_descartada_e_servidor_morto_e_substituido() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("main.rs");
        let manager = LspManager::new(root.clone(), |_, _| {});
        let start = || {
            manager
                .client_with(&file, Some((fake_spec(), "rust")))
                .unwrap()
                .unwrap()
                .0
        };
        let client = start();

        // JSON inválido e cabeçalho sem Content-Length não derrubam a leitura.
        assert_eq!(
            client.request("lixo", Value::Null).unwrap(),
            "depois do lixo"
        );
        assert!(client.is_alive());

        // O servidor morre no meio de um pedido: erro imediato, sem esperar o timeout.
        let began = std::time::Instant::now();
        assert!(matches!(
            client.request("morre", Value::Null),
            Err(Error::Closed)
        ));
        assert!(began.elapsed() < Duration::from_secs(10));
        for _ in 0..100 {
            if !client.is_alive() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!client.is_alive());

        // O próximo uso sobe outro processo.
        let again = start();
        assert!(!Arc::ptr_eq(&client, &again));
        assert!(again.is_alive());
        manager.shutdown();
    }

    #[test]
    fn documentos_descartam_versoes_velhas_e_reabrem_apos_reinicio() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("main.rs");
        let (tx, rx) = mpsc::channel();
        let manager = LspManager::with_spec(root.clone(), fake_spec(), "rust", move |_, d| {
            let _ = tx.send(d);
        });
        let text_in_server = || {
            let (client, _) = manager.client_for(&file).unwrap().unwrap();
            client
                .request("texto", json!({ "uri": uri(&file).unwrap() }))
                .unwrap()
        };

        assert!(manager.open_document(&file, "v1").unwrap());
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        manager.change_document(&file, 3, "v3").unwrap();
        // Chegou depois da v3 (outra thread): ignorada.
        manager.change_document(&file, 2, "v2").unwrap();
        assert_eq!(text_in_server(), "v3");

        // O servidor morre; a próxima mudança vai para um novo, que recebe didOpen.
        let (client, _) = manager.client_for(&file).unwrap().unwrap();
        let _ = client.request("morre", Value::Null);
        while client.is_alive() {
            std::thread::sleep(Duration::from_millis(20));
        }
        manager.change_document(&file, 4, "v4").unwrap();
        rx.recv_timeout(Duration::from_secs(10)).unwrap(); // diagnóstico do didOpen
        assert_eq!(text_in_server(), "v4");

        manager.close_document(&file).unwrap();
        manager.change_document(&file, 5, "v5").unwrap(); // fechado: nada é enviado
        assert_eq!(text_in_server(), "v4");
        manager.shutdown();
    }

    #[test]
    fn servidor_nao_instalado_vira_erro_claro_e_nao_repete() {
        let dir = tempfile::tempdir().unwrap();
        let manager = LspManager::new(dir.path().to_path_buf(), |_, _| {});
        let spec = ServerSpec {
            key: "nada",
            command: "servidor-que-nao-existe-123".into(),
            args: vec![],
        };
        let file = dir.path().join("a.rs");
        for _ in 0..2 {
            assert!(matches!(
                manager.client_with(&file, Some((spec.clone(), "rust"))),
                Err(Error::NotInstalled(c)) if c == "servidor-que-nao-existe-123"
            ));
        }
        assert!(manager
            .client_for(&dir.path().join("README.md"))
            .unwrap()
            .is_none());
    }

    /// Contra o rust-analyzer de verdade (fora do CI): `cargo test -p ide-lsp -- --ignored`.
    #[test]
    #[ignore = "precisa do rust-analyzer instalado"]
    fn rust_analyzer_real() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let src = "/// Soma dois números.\npub fn soma(a: i32, b: i32) -> i32 { a + b }\n\npub fn usa() -> i32 { soma(1, 2) }\n";
        let file = root.join("src/lib.rs");
        std::fs::write(&file, src).unwrap();

        let manager = LspManager::new(root.clone(), |_, _| {});
        let (client, lang) = manager.client_for(&file).unwrap().unwrap();
        client.did_open(&file, lang, 1, src).unwrap();

        // O rust-analyzer responde vazio enquanto indexa: tenta por alguns segundos.
        let call = Position {
            line: 3,
            character: 22,
        };
        let mut hover = None;
        for _ in 0..60 {
            hover = client.hover(&file, call.clone()).unwrap();
            if hover.as_deref().is_some_and(|h| h.contains("soma")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let hover = hover.expect("sem hover");
        assert!(hover.contains("Soma dois números"), "{hover}");

        let defs = client.definition(&file, call).unwrap();
        assert_eq!(defs[0].path, file);
        assert_eq!(defs[0].range.start.line, 1);
        manager.shutdown();
    }

    #[test]
    fn hover_em_varios_formatos() {
        assert_eq!(hover_text(&json!("texto")).as_deref(), Some("texto"));
        assert_eq!(
            hover_text(&json!({ "language": "rust", "value": "fn a()" })).as_deref(),
            Some("```rust\nfn a()\n```")
        );
        assert_eq!(
            hover_text(&json!(["a", { "kind": "markdown", "value": "b" }])).as_deref(),
            Some("a\n\nb")
        );
    }

    #[test]
    fn escolhe_servidor_pela_extensao() {
        let (spec, lang) = spec_for(Path::new("App.tsx")).unwrap();
        assert_eq!(
            (spec.command.as_str(), lang),
            ("typescript-language-server", "typescriptreact")
        );
        assert_eq!(spec_for(Path::new("x.rs")).unwrap().0.key, "rust");
        assert!(spec_for(Path::new("x.md")).is_none());
    }
}
