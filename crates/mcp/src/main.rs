//! `ide-mcp --root <projeto>`: servidor MCP via stdio (uma mensagem JSON por linha).

use std::io::{BufRead, Write};
use std::path::PathBuf;

use ide_mcp::Server;
use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut root = None;
    while let Some(arg) = args.next() {
        if arg == "--root" {
            root = args.next().map(PathBuf::from);
        }
    }
    let root = root
        .or_else(|| std::env::current_dir().ok())
        .and_then(|r| r.canonicalize().ok())
        .unwrap_or_else(|| {
            eprintln!("ide-mcp: raiz do projeto inválida");
            std::process::exit(2);
        });

    let server = Server::new(root);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => server.handle(&message),
            Err(e) => Some(serde_json::json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("JSON inválido: {e}") }
            })),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
    server.shutdown();
}
