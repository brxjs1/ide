//! Comandos do quadro de tarefas (crates/core::board).

use std::path::PathBuf;

use ide_core::board::{self, BoardTask, Status};

use crate::editor::blocking;
use crate::state::err;

#[tauri::command]
pub async fn board_list(root: PathBuf) -> Result<Vec<BoardTask>, String> {
    blocking(move || board::list(&root).map_err(err)).await
}

#[tauri::command]
pub async fn board_create(
    root: PathBuf,
    title: String,
    status: Status,
    priority: Option<String>,
    description: Option<String>,
) -> Result<BoardTask, String> {
    blocking(move || {
        board::create(
            &root,
            &title,
            status,
            priority.as_deref(),
            description.as_deref(),
        )
        .map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn board_set_status(
    root: PathBuf,
    slug: String,
    status: Status,
) -> Result<BoardTask, String> {
    blocking(move || board::set_status(&root, &slug, status).map_err(err)).await
}

/// Só os metadados que a interface edita.
#[tauri::command]
pub async fn board_set_meta(
    root: PathBuf,
    slug: String,
    key: String,
    value: Option<String>,
) -> Result<BoardTask, String> {
    if !matches!(key.as_str(), "Prioridade" | "Worktree") {
        return Err(format!("metadado não editável pela interface: {key}"));
    }
    blocking(move || board::set_meta(&root, &slug, &key, value.as_deref()).map_err(err)).await
}

#[tauri::command]
pub async fn board_delete(root: PathBuf, slug: String) -> Result<(), String> {
    blocking(move || board::delete(&root, &slug).map_err(err)).await
}
