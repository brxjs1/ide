//! Comandos do editor: arquivos, estrutura (tree-sitter) e servidores de linguagem.
//! Caminhos chegam relativos à raiz e passam por `ide_core::files::resolve`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::files::{self, Entry};
use ide_lsp::{Diagnostic, LspManager, Position, Range};
use ide_syntax::Symbol;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{err, AppState};

// Todos fora da thread principal (`blocking`): percorrer 20 mil entradas ou analisar um
// arquivo grande congelaria a janela.

#[tauri::command]
pub async fn files_tree(root: PathBuf) -> Result<Vec<Entry>, String> {
    blocking(move || files::tree(&root).map_err(err)).await
}

#[tauri::command]
pub async fn file_read(root: PathBuf, path: String) -> Result<String, String> {
    blocking(move || files::read(&root, &path).map_err(err)).await
}

#[tauri::command]
pub async fn file_write(root: PathBuf, path: String, content: String) -> Result<(), String> {
    blocking(move || files::write(&root, &path, &content).map_err(err)).await
}

#[tauri::command]
pub async fn file_outline(root: PathBuf, path: String) -> Result<Vec<Symbol>, String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        match ide_syntax::Lang::from_path(&abs) {
            Some(_) => ide_syntax::outline_file(&abs).map_err(err),
            None => Ok(Vec::new()),
        }
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsEvent {
    path: String,
    diagnostics: Vec<Diagnostic>,
}

/// Gerenciador de LSP da raiz; diagnósticos saem como evento `lsp://diagnostics`.
fn manager(app: &AppHandle, root: &Path) -> Result<Arc<LspManager>, String> {
    let root = root.canonicalize().map_err(err)?;
    let state = app.state::<AppState>();
    let mut all = state.lsp.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(m) = all.get(&root) {
        return Ok(Arc::clone(m));
    }
    let emitter = app.clone();
    let event_root = root.clone();
    let manager = Arc::new(LspManager::new(root.clone(), move |path, diagnostics| {
        if let Ok(rel) = path.strip_prefix(&event_root) {
            let _ = emitter.emit(
                "lsp://diagnostics",
                DiagnosticsEvent {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    diagnostics,
                },
            );
        }
    }));
    all.insert(root, Arc::clone(&manager));
    Ok(manager)
}

/// Roda fora da thread principal: iniciar um servidor de linguagem pode levar segundos.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

/// Abre o arquivo no servidor da linguagem. Devolve `false` se não há servidor para ele;
/// erro se o servidor não está instalado (a UI mostra uma vez).
#[tauri::command]
pub async fn lsp_open(
    app: AppHandle,
    root: PathBuf,
    path: String,
    text: String,
) -> Result<bool, String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        manager(&app, &root)?
            .open_document(&abs, &text)
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn lsp_change(
    app: AppHandle,
    root: PathBuf,
    path: String,
    version: i32,
    text: String,
) -> Result<(), String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        manager(&app, &root)?
            .change_document(&abs, version, &text)
            .map_err(err)
    })
    .await
}

/// Depois de gravar o arquivo: o servidor refaz a checagem do compilador.
#[tauri::command]
pub async fn lsp_save(
    app: AppHandle,
    root: PathBuf,
    path: String,
    text: String,
) -> Result<(), String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        manager(&app, &root)?
            .save_document(&abs, &text)
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn lsp_close(app: AppHandle, root: PathBuf, path: String) -> Result<(), String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        manager(&app, &root)?.close_document(&abs).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn lsp_hover(
    app: AppHandle,
    root: PathBuf,
    path: String,
    line: u32,
    character: u32,
) -> Result<Option<String>, String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        let Some((client, _)) = manager(&app, &root)?.client_for(&abs).map_err(err)? else {
            return Ok(None);
        };
        client
            .hover(&abs, Position { line, character })
            .map_err(err)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Relativo à raiz; `None` se a definição está fora do projeto (ex.: biblioteca).
    path: Option<String>,
    absolute: String,
    range: Range,
}

#[tauri::command]
pub async fn lsp_definition(
    app: AppHandle,
    root: PathBuf,
    path: String,
    line: u32,
    character: u32,
) -> Result<Vec<Target>, String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        let Some((client, _)) = manager(&app, &root)?.client_for(&abs).map_err(err)? else {
            return Ok(Vec::new());
        };
        let canonical_root = root.canonicalize().map_err(err)?;
        let defs = client
            .definition(&abs, Position { line, character })
            .map_err(err)?;
        Ok(defs
            .into_iter()
            .map(|d| Target {
                path: d
                    .path
                    .strip_prefix(&canonical_root)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/")),
                absolute: d.path.to_string_lossy().into_owned(),
                range: d.range,
            })
            .collect())
    })
    .await
}

/// Encerra os servidores de linguagem ao sair.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let managers: Vec<_> = state
            .lsp
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        for (_, manager) in managers {
            manager.shutdown();
        }
    }
}
