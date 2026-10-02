use std::path::PathBuf;

use ide_core::ProjectInfo;

/// Estado git do projeto em `path` (padrão: diretório atual do processo).
#[tauri::command]
pub fn project_info(path: Option<PathBuf>) -> Result<ProjectInfo, String> {
    let path = match path {
        Some(p) => p,
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    ProjectInfo::load(&path).map_err(|e| e.to_string())
}
