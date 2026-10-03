//! Comandos da análise de qualidade (crates/lint): problemas de um arquivo (o texto do
//! editor, salvo ou não), do projeto inteiro e o catálogo de regras.

use std::path::PathBuf;

use ide_core::files;
use ide_lint::{Issue, Lang, ProjectReport, Rule};

use crate::editor::blocking;
use crate::state::err;

/// Problemas no texto atual do editor (antes de salvar). `path` só define a linguagem.
#[tauri::command]
pub async fn lint_source(root: PathBuf, path: String, text: String) -> Result<Vec<Issue>, String> {
    blocking(move || {
        let abs = files::resolve(&root, &path).map_err(err)?;
        Ok(Lang::from_path(&abs)
            .map(|lang| ide_lint::lint_source(&text, lang))
            .unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn lint_project(root: PathBuf) -> Result<ProjectReport, String> {
    blocking(move || Ok(ide_lint::lint_project(&root, 5000))).await
}

#[tauri::command]
pub fn lint_rules() -> Vec<Rule> {
    ide_lint::rules().to_vec()
}
