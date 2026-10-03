//! Servidor MCP do ide: ferramentas de leitura de código para o agente, limitadas à raiz
//! do projeto. Transporte stdio do MCP: uma mensagem JSON-RPC por linha.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use ide_core::files;
use ide_lsp::{Diagnostic, LspManager, Position};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// Versões do MCP que este servidor entende (a primeira é a preferida).
const SUPPORTED_VERSIONS: [&str; 3] = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

/// Diagnósticos recebidos do LSP, por arquivo, com o momento da última atualização.
#[derive(Default)]
struct DiagStore {
    by_path: Mutex<HashMap<PathBuf, (Instant, Vec<Diagnostic>)>>,
    changed: Condvar,
}

pub struct Server {
    root: PathBuf,
    lsp: LspManager,
    diags: Arc<DiagStore>,
    /// Arquivos já abertos no LSP: servidor (endereço do cliente), versão e texto enviados
    /// por último. Se o servidor foi reiniciado, o arquivo é aberto de novo.
    opened: Mutex<HashMap<PathBuf, (usize, i32, String)>>,
}

impl Server {
    pub fn new(root: PathBuf) -> Self {
        Self::build(root, None)
    }

    /// Como [`Server::new`], com um único servidor de linguagem para qualquer arquivo.
    pub fn with_lsp(root: PathBuf, spec: ide_lsp::ServerSpec, language_id: &'static str) -> Self {
        Self::build(root, Some((spec, language_id)))
    }

    fn build(root: PathBuf, spec_override: Option<(ide_lsp::ServerSpec, &'static str)>) -> Self {
        // Canônica: o servidor de linguagem publica caminhos canônicos, e são as chaves aqui.
        let root = root.canonicalize().unwrap_or(root);
        let diags = Arc::new(DiagStore::default());
        let sink = Arc::clone(&diags);
        let on_diagnostics = move |path, list| {
            sink.by_path
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(path, (Instant::now(), list));
            sink.changed.notify_all();
        };
        let lsp = match spec_override {
            Some((spec, lang)) => LspManager::with_spec(root.clone(), spec, lang, on_diagnostics),
            None => LspManager::new(root.clone(), on_diagnostics),
        };
        Self {
            root,
            lsp,
            diags,
            opened: Mutex::default(),
        }
    }

    /// Trata uma mensagem; devolve a resposta (notificações não têm resposta).
    pub fn handle(&self, message: &Value) -> Option<Value> {
        let id = message.get("id")?.clone();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"]
                    .as_str()
                    .filter(|v| SUPPORTED_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "ide", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Ferramentas de leitura de código do projeto: estrutura (tree-sitter) e servidor de linguagem (LSP). Prefira-as a ler arquivos inteiros quando só precisa da estrutura ou de onde algo é definido."
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => {
                Ok(self.call(params["name"].as_str().unwrap_or(""), &params["arguments"]))
            }
            other => {
                Err(json!({ "code": -32601, "message": format!("método desconhecido: {other}") }))
            }
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
        })
    }

    fn call(&self, name: &str, args: &Value) -> Value {
        let outcome = match name {
            "outline_file" => self.outline_file(args),
            "find_symbol" => self.find_symbol(args),
            "project_tree" => self.project_tree(args),
            "diagnostics" => self.diagnostics(args),
            "definition" => self.definition(args),
            "code_issues" => self.code_issues(args),
            "task_board" => self.task_board(),
            other => Err(format!("ferramenta desconhecida: {other}")),
        };
        match outcome {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
        }
    }

    fn path_arg(&self, args: &Value) -> Result<(String, PathBuf), String> {
        let rel = args["path"]
            .as_str()
            .ok_or("parâmetro 'path' obrigatório")?;
        let rel = rel.trim_start_matches("./").to_owned();
        let abs = files::resolve(&self.root, &rel).map_err(|e| e.to_string())?;
        // Mesma grafia que o servidor de linguagem usa ao publicar (symlinks, maiúsculas).
        let abs = std::fs::canonicalize(&abs).unwrap_or(abs);
        Ok((rel, abs))
    }

    fn outline_file(&self, args: &Value) -> Result<String, String> {
        let (rel, abs) = self.path_arg(args)?;
        let symbols = ide_syntax::outline_file(&abs).map_err(|e| e.to_string())?;
        if symbols.is_empty() {
            return Ok(format!("{rel}: nenhum símbolo encontrado"));
        }
        let mut out = format!("{rel}\n");
        for s in symbols {
            let _ = writeln!(
                out,
                "{}{} {} (linhas {}-{})",
                "  ".repeat(s.depth as usize + 1),
                s.kind,
                s.name,
                s.line,
                s.end_line
            );
        }
        Ok(out)
    }

    fn find_symbol(&self, args: &Value) -> Result<String, String> {
        let name = args["name"]
            .as_str()
            .ok_or("parâmetro 'name' obrigatório")?;
        let limit = args["limit"].as_u64().unwrap_or(30).clamp(1, 200) as usize;
        let found = ide_syntax::find_symbol(&self.root, name, limit).map_err(|e| e.to_string())?;
        if found.is_empty() {
            return Ok(format!("nenhuma definição para '{name}'"));
        }
        Ok(found
            .iter()
            .map(|m| {
                let container = m
                    .symbol
                    .container
                    .as_ref()
                    .map(|c| format!(" em {c}"))
                    .unwrap_or_default();
                format!(
                    "{}:{} {} {}{container}",
                    m.path, m.symbol.line, m.symbol.kind, m.symbol.name
                )
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    fn project_tree(&self, args: &Value) -> Result<String, String> {
        let prefix = args["path"]
            .as_str()
            .unwrap_or("")
            .trim_matches('/')
            .to_owned();
        let max_depth = args["depth"].as_u64().unwrap_or(3).clamp(1, 10) as usize;
        // Começa na pasta pedida: o limite de entradas do walk não esconde pastas fundas.
        let start = if prefix.is_empty() {
            self.root.clone()
        } else {
            files::resolve(&self.root, &prefix).map_err(|e| e.to_string())?
        };
        let entries = files::tree(&start).map_err(|e| e.to_string())?;
        let mut out = String::new();
        let mut shown = 0;
        for entry in entries {
            let rest = entry.path.as_str();
            let depth = rest.matches('/').count();
            if depth >= max_depth {
                continue;
            }
            let name = rest.rsplit('/').next().unwrap_or(rest);
            let _ = writeln!(
                out,
                "{}{}{}",
                "  ".repeat(depth),
                name,
                if entry.dir { "/" } else { "" }
            );
            shown += 1;
            if shown >= 500 {
                out.push_str("… (cortado em 500 entradas; use 'path' para uma pasta)\n");
                break;
            }
        }
        Ok(if out.is_empty() {
            "(vazio)".into()
        } else {
            out
        })
    }

    /// Abre (ou atualiza) o arquivo no servidor de linguagem. Devolve também se algo foi
    /// enviado (abertura ou mudança): sem envio, o servidor não publica de novo.
    fn sync_open(&self, abs: &Path) -> Result<(Arc<ide_lsp::LspClient>, bool), String> {
        let (client, lang) = self
            .lsp
            .client_for(abs)
            .map_err(|e| e.to_string())?
            .ok_or("sem servidor de linguagem para este tipo de arquivo")?;
        let size = std::fs::metadata(abs).map_err(|e| e.to_string())?.len();
        if size > files::MAX_FILE_BYTES {
            return Err(format!("arquivo grande demais ({size} bytes)"));
        }
        let text = std::fs::read_to_string(abs).map_err(|e| e.to_string())?;
        let server = Arc::as_ptr(&client) as usize;
        let mut opened = self.opened.lock().unwrap_or_else(|e| e.into_inner());
        let sent = match opened.get_mut(abs).filter(|(s, _, _)| *s == server) {
            // Reenviar o mesmo texto faz o servidor reanalisar e cancelar pedidos em curso.
            Some((_, _, last)) if *last == text => false,
            Some((_, version, last)) => {
                *version += 1;
                client
                    .did_change(abs, *version, &text)
                    .map_err(|e| e.to_string())?;
                // O arquivo mudou em disco: didSave faz o servidor rodar o check de novo.
                client.did_save(abs, &text).map_err(|e| e.to_string())?;
                *last = text;
                true
            }
            None => {
                client
                    .did_open(abs, lang, 1, &text)
                    .map_err(|e| e.to_string())?;
                opened.insert(abs.to_path_buf(), (server, 1, text));
                true
            }
        };
        Ok((client, sent))
    }

    fn diagnostics(&self, args: &Value) -> Result<String, String> {
        let (rel, abs) = self.path_arg(args)?;
        let asked = Instant::now();
        let (_, sent) = self.sync_open(&abs)?;
        // Nada mudou desde a última vez: a última publicação ainda vale (o servidor não vai
        // publicar de novo), só espera o silêncio caso ainda esteja chegando.
        let since = if sent {
            asked
        } else {
            let store = self.diags.by_path.lock().unwrap_or_else(|e| e.into_inner());
            store.get(&abs).map_or(asked, |(t, _)| *t)
        };
        // Espera a primeira publicação depois do pedido e mais um instante de silêncio,
        // porque servidores costumam publicar em etapas.
        let deadline = asked + Duration::from_secs(args["timeout"].as_u64().unwrap_or(20).min(60));
        let quiet = Duration::from_millis(1500);
        let mut store = self.diags.by_path.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let latest = store.get(&abs).map(|(t, _)| *t).filter(|t| *t >= since);
            let now = Instant::now();
            if now >= deadline || latest.is_some_and(|t| now.duration_since(t) >= quiet) {
                break;
            }
            let wait = match latest {
                Some(t) => quiet.saturating_sub(now.duration_since(t)),
                None => deadline - now,
            };
            store = self
                .diags
                .changed
                .wait_timeout(store, wait.min(deadline - now))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        let Some((_, list)) = store.get(&abs).filter(|(t, _)| *t >= since) else {
            return Ok(format!("{rel}: o servidor de linguagem não publicou diagnósticos a tempo (pode estar indexando)"));
        };
        if list.is_empty() {
            return Ok(format!("{rel}: sem erros nem avisos"));
        }
        const SEVERITY: [&str; 5] = ["?", "erro", "aviso", "info", "dica"];
        Ok(list
            .iter()
            .map(|d| {
                format!(
                    "{rel}:{}:{} {}: {}{}",
                    d.range.start.line + 1,
                    d.range.start.character + 1,
                    SEVERITY.get(d.severity as usize).unwrap_or(&"?"),
                    d.message,
                    d.source
                        .as_ref()
                        .map(|s| format!(" [{s}]"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    fn definition(&self, args: &Value) -> Result<String, String> {
        let (rel, abs) = self.path_arg(args)?;
        let line = args["line"]
            .as_u64()
            .ok_or("parâmetro 'line' (1-based) obrigatório")?;
        let column = args["column"]
            .as_u64()
            .ok_or("parâmetro 'column' (1-based) obrigatório")?;
        let (client, _) = self.sync_open(&abs)?;
        let pos = Position {
            line: line.saturating_sub(1) as u32,
            character: column.saturating_sub(1) as u32,
        };
        // "content modified" (-32801) é transitório: o servidor ainda está reanalisando.
        let mut attempt = 0;
        let defs = loop {
            match client.definition(&abs, pos.clone()) {
                Ok(defs) => break defs,
                Err(ide_lsp::Error::Server(m))
                    if m.contains("content modified") && attempt < 10 =>
                {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(300));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        if defs.is_empty() {
            return Ok(format!(
                "{rel}:{line}:{column}: nenhuma definição encontrada"
            ));
        }
        Ok(defs
            .iter()
            .map(|d| {
                let shown = d
                    .path
                    .strip_prefix(&self.root)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| d.path.display().to_string());
                format!(
                    "{shown}:{}:{}",
                    d.range.start.line + 1,
                    d.range.start.character + 1
                )
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Problemas de qualidade (crates/lint) de um arquivo, ou resumo do projeto.
    fn code_issues(&self, args: &Value) -> Result<String, String> {
        let describe = |i: &ide_lint::Issue| {
            let fix = ide_lint::rule(i.rule)
                .map(|r| format!("\n    como corrigir: {}", r.fix))
                .unwrap_or_default();
            format!(
                "{}:{} [{} {:?}/{:?}] {}{fix}",
                i.span.line, i.span.column, i.rule, i.kind, i.severity, i.message
            )
        };
        if args["path"].is_string() {
            let (rel, abs) = self.path_arg(args)?;
            let issues = ide_lint::lint_path(&abs).map_err(|e| e.to_string())?;
            if issues.is_empty() {
                return Ok(format!("{rel}: nenhum problema encontrado"));
            }
            let lines: Vec<String> = issues
                .iter()
                .map(|i| format!("{rel}:{}", describe(i)))
                .collect();
            return Ok(lines.join("\n"));
        }
        let report = ide_lint::lint_project(&self.root, 5000);
        let r = &report.ratings;
        let mut out = format!(
            "{} arquivos, {} linhas · notas: manutenibilidade {}, confiabilidade {}, segurança {} · dívida {} min\n",
            report.files_analyzed, report.lines, r.maintainability, r.reliability, r.security, r.debt_minutes
        );
        let limit = args["limit"].as_u64().unwrap_or(40).clamp(1, 500) as usize;
        let mut shown = 0;
        'files: for file in &report.files {
            for issue in &file.issues {
                if shown == limit {
                    out.push_str("… (use 'path' para ver um arquivo inteiro)\n");
                    break 'files;
                }
                let _ = writeln!(out, "{}:{}", file.path, describe(issue));
                shown += 1;
            }
        }
        if report.files.is_empty() {
            out.push_str("nenhum problema encontrado\n");
        }
        Ok(out)
    }

    /// Quadro de tarefas de `.project/tasks/` (a fazer / em progresso / concluídas).
    fn task_board(&self) -> Result<String, String> {
        let tasks = ide_core::board::list(&self.root).map_err(|e| e.to_string())?;
        if tasks.is_empty() {
            return Ok("Quadro vazio (.project/tasks/ sem tarefas).".into());
        }
        let mut out = String::new();
        for status in [
            ide_core::board::Status::Doing,
            ide_core::board::Status::Todo,
            ide_core::board::Status::Done,
        ] {
            let group: Vec<_> = tasks.iter().filter(|t| t.status == status).collect();
            if group.is_empty() {
                continue;
            }
            let _ = writeln!(out, "## {} ({})", status.label(), group.len());
            for t in group {
                let progress = if t.checklist_total > 0 {
                    format!(" [{}/{}]", t.checklist_done, t.checklist_total)
                } else {
                    String::new()
                };
                let priority = t
                    .priority
                    .as_deref()
                    .map(|p| format!(" ({p})"))
                    .unwrap_or_default();
                let _ = writeln!(out, "- {}{priority}{progress} — {}", t.title, t.path);
            }
        }
        out.push_str("Para mudar o status, edite a linha `- Status:` do arquivo (a fazer | em progresso | concluída).");
        Ok(out)
    }

    pub fn shutdown(&self) {
        self.lsp.shutdown();
    }
}

fn tools() -> Value {
    let path = json!({ "type": "string", "description": "Caminho relativo à raiz do projeto" });
    json!([
        {
            "name": "outline_file",
            "description": "Estrutura de um arquivo (funções, classes, structs, métodos...) com linhas, via tree-sitter. Rust, TypeScript/TSX, JavaScript, Python e Go. Use antes de ler um arquivo grande inteiro.",
            "inputSchema": { "type": "object", "properties": { "path": path }, "required": ["path"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "find_symbol",
            "description": "Onde um nome (função, tipo, classe...) é definido no projeto. Nome exato primeiro, depois quem começa com o nome.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
            }, "required": ["name"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "project_tree",
            "description": "Árvore de arquivos do projeto respeitando .gitignore.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Pasta relativa (padrão: raiz)" },
                "depth": { "type": "integer", "minimum": 1, "maximum": 10 }
            } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "diagnostics",
            "description": "Erros e avisos do servidor de linguagem (rust-analyzer, typescript-language-server, pyright, gopls) para um arquivo, no estado atual em disco.",
            "inputSchema": { "type": "object", "properties": {
                "path": path,
                "timeout": { "type": "integer", "minimum": 1, "maximum": 60, "description": "Segundos de espera (padrão 20)" }
            }, "required": ["path"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "code_issues",
            "description": "Problemas de qualidade no estilo SonarLint (bugs, vulnerabilidades, code smells) com a regra e como corrigir. Com 'path', um arquivo; sem, o resumo do projeto com notas A-E. Só lê arquivos (tree-sitter).",
            "inputSchema": { "type": "object", "properties": {
                "path": path,
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Máximo de problemas no resumo do projeto (padrão 40)" }
            } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "task_board",
            "description": "Quadro de tarefas do projeto (.project/tasks/): o que está a fazer, em progresso e concluído, com prioridade e progresso do checklist.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "definition",
            "description": "Onde está definido o símbolo na posição dada (linha e coluna a partir de 1), via servidor de linguagem.",
            "inputSchema": { "type": "object", "properties": {
                "path": path,
                "line": { "type": "integer", "minimum": 1 },
                "column": { "type": "integer", "minimum": 1 }
            }, "required": ["path", "line", "column"] },
            "annotations": { "readOnlyHint": true }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(server: &Server, name: &str, args: Value) -> (bool, String) {
        let reply = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } }))
            .unwrap();
        let result = &reply["result"];
        (
            result["isError"].as_bool().unwrap_or(false),
            result["content"][0]["text"].as_str().unwrap().to_owned(),
        )
    }

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/util")).unwrap();
        std::fs::write(
            root.join("src/lib.rs"),
            "pub struct Conta;\nimpl Conta {\n    pub fn sacar(&self) {}\n}\n",
        )
        .unwrap();
        std::fs::write(root.join("src/util/mod.rs"), "pub fn ajuda() {}\n").unwrap();
        dir
    }

    #[test]
    fn handshake_e_lista_de_ferramentas() {
        let dir = project();
        let server = Server::new(dir.path().to_path_buf());
        let init = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(server
            .handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none());
        let list = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .unwrap();
        let names: Vec<_> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "outline_file",
                "find_symbol",
                "project_tree",
                "diagnostics",
                "code_issues",
                "task_board",
                "definition"
            ]
        );
        let unknown = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }))
            .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn ferramentas_de_estrutura() {
        let dir = project();
        let server = Server::new(dir.path().to_path_buf());

        let (err, text) = call(&server, "outline_file", json!({ "path": "./src/lib.rs" }));
        assert!(!err);
        assert!(text.contains("struct Conta (linhas 1-1)"), "{text}");
        assert!(text.contains("    method sacar (linhas 3-3)"), "{text}");

        let (_, text) = call(&server, "find_symbol", json!({ "name": "sacar" }));
        assert_eq!(text, "src/lib.rs:3 method sacar em Conta");

        let (_, text) = call(&server, "project_tree", json!({}));
        assert_eq!(text, "src/\n  util/\n    mod.rs\n  lib.rs\n");
        let (_, text) = call(
            &server,
            "project_tree",
            json!({ "path": "src", "depth": 1 }),
        );
        assert_eq!(text, "util/\nlib.rs\n");
    }

    #[test]
    fn recusa_caminhos_fora_do_projeto_e_erros_viram_is_error() {
        let dir = project();
        let server = Server::new(dir.path().to_path_buf());
        for (tool, args) in [
            ("outline_file", json!({ "path": "../fora.rs" })),
            ("diagnostics", json!({ "path": "/etc/passwd" })),
            ("project_tree", json!({ "path": "../.." })),
        ] {
            let (err, text) = call(&server, tool, args);
            assert!(err, "{tool}: {text}");
            assert!(text.contains("fora do projeto"), "{tool}: {text}");
        }
        let (err, text) = call(&server, "outline_file", json!({}));
        assert!(err && text.contains("'path'"));
        let (err, _) = call(&server, "nao_existe", json!({}));
        assert!(err);
    }

    /// Servidor LSP falso: publica um diagnóstico ao abrir e ao salvar (com o texto salvo),
    /// e responde "content modified" na primeira definição, como o rust-analyzer indexando.
    const FAKE_LSP: &str = r#"
let buf = Buffer.alloc(0), defs = 0;
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`); process.stdout.write(b); };
const publish = (uri, message) => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri,
  diagnostics: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }, severity: 1, message, source: "fake" }] } });
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n"); if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const m = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString()); buf = buf.slice(sep + 4 + len);
    switch (m.method) {
      case "initialize": send({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } }); break;
      case "textDocument/didOpen": publish(m.params.textDocument.uri, "aberto"); break;
      case "textDocument/didSave": publish(m.params.textDocument.uri, "salvo: " + m.params.text.split("\n")[0]); break;
      case "textDocument/definition":
        if (defs++ === 0) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32801, message: "content modified" } }); break; }
        send({ jsonrpc: "2.0", id: m.id, result: [{ uri: m.params.textDocument.uri,
          range: { start: { line: 2, character: 11 }, end: { line: 2, character: 16 } } }] }); break;
      case "shutdown": send({ jsonrpc: "2.0", id: m.id, result: null }); break;
      case "exit": process.exit(0);
    }
  }
});
"#;

    fn fake_server(root: &Path) -> Server {
        let spec = ide_lsp::ServerSpec {
            key: "fake",
            command: "node".into(),
            args: vec!["-e".into(), FAKE_LSP.into()],
        };
        Server::with_lsp(root.to_path_buf(), spec, "rust")
    }

    #[test]
    fn diagnosticos_abrem_reaproveitam_e_acompanham_o_disco() {
        let dir = project();
        let server = fake_server(dir.path());
        let args = json!({ "path": "src/lib.rs", "timeout": 10 });

        let (err, text) = call(&server, "diagnostics", args.clone());
        assert!(!err, "{text}");
        assert_eq!(text, "src/lib.rs:1:5 erro: aberto [fake]");

        // Sem mudança: o servidor não publica de novo, a resposta vem do que já chegou.
        let began = Instant::now();
        let (_, again) = call(&server, "diagnostics", args.clone());
        assert_eq!(again, text);
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );

        // O arquivo mudou em disco: didChange + didSave, e o resultado novo.
        std::fs::write(dir.path().join("src/lib.rs"), "pub struct Outra;\n").unwrap();
        let (_, changed) = call(&server, "diagnostics", args);
        assert_eq!(
            changed,
            "src/lib.rs:1:5 erro: salvo: pub struct Outra; [fake]"
        );
        server.shutdown();
    }

    #[test]
    fn definicao_repete_enquanto_o_servidor_reanalisa() {
        let dir = project();
        let server = fake_server(dir.path());
        let (err, text) = call(
            &server,
            "definition",
            json!({ "path": "src/lib.rs", "line": 4, "column": 5 }),
        );
        assert!(!err, "{text}");
        assert_eq!(text, "src/lib.rs:3:12");
        server.shutdown();
    }

    #[test]
    fn problemas_de_qualidade_e_quadro_de_tarefas() {
        let dir = project();
        std::fs::write(
            dir.path().join("src/app.ts"),
            "var total: any = 1;\nif (total == 2) { }\n",
        )
        .unwrap();
        let server = Server::new(dir.path().to_path_buf());

        let (err, text) = call(&server, "code_issues", json!({ "path": "src/app.ts" }));
        assert!(!err, "{text}");
        assert!(text.contains("src/app.ts:1:1 [S3504"), "{text}");
        assert!(text.contains("como corrigir:"), "{text}");
        let (_, project) = call(&server, "code_issues", json!({}));
        assert!(
            project.starts_with("1 arquivos") || project.contains("arquivos,"),
            "{project}"
        );
        assert!(project.contains("S1440"), "{project}");
        let (_, clean) = call(&server, "code_issues", json!({ "path": "src/lib.rs" }));
        assert_eq!(clean, "src/lib.rs: nenhum problema encontrado");
        let (err, _) = call(&server, "code_issues", json!({ "path": "../fora.ts" }));
        assert!(err);

        let (_, empty) = call(&server, "task_board", json!({}));
        assert!(empty.starts_with("Quadro vazio"));
        ide_core::board::create(
            dir.path(),
            "Validar CPF",
            ide_core::board::Status::Doing,
            Some("alta"),
            None,
        )
        .unwrap();
        let (_, board) = call(&server, "task_board", json!({}));
        assert!(
            board.contains(
                "## em progresso (1)\n- Validar CPF (alta) — .project/tasks/validar-cpf.md"
            ),
            "{board}"
        );
    }

    #[test]
    fn arvore_a_partir_de_uma_pasta() {
        let dir = project();
        let server = Server::new(dir.path().to_path_buf());
        let (err, text) = call(&server, "project_tree", json!({ "path": "src" }));
        assert!(!err, "{text}");
        assert_eq!(text, "util/\n  mod.rs\nlib.rs\n");
    }
}
