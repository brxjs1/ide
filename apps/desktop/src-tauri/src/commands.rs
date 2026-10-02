use std::path::PathBuf;

use ide_core::{diff, ChangedFile, ProjectInfo};
use ide_timeline::Event;
use tauri::State;

use crate::state::{err, AppState};

/// Estado git do projeto em `path` (padrão: diretório atual do processo).
#[tauri::command]
pub fn project_info(path: Option<PathBuf>) -> Result<ProjectInfo, String> {
    let path = match path {
        Some(p) => p,
        None => std::env::current_dir().map_err(err)?,
    };
    ProjectInfo::load(&path).map_err(err)
}

#[tauri::command]
pub fn changed_files(root: PathBuf) -> Result<Vec<ChangedFile>, String> {
    diff::changed_files(&root).map_err(err)
}

#[tauri::command]
pub fn file_diff(root: PathBuf, path: String) -> Result<String, String> {
    diff::file_diff(&root, &path).map_err(err)
}

#[tauri::command]
pub fn timeline_list(
    state: State<'_, AppState>,
    project: String,
    limit: Option<u32>,
    before: Option<i64>,
) -> Result<Vec<Event>, String> {
    state
        .timeline
        .list(&project, limit.unwrap_or(200).min(1000), before)
        .map_err(err)
}
