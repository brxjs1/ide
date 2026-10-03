use std::path::PathBuf;

use ide_core::{diff, history, tasks, ChangedFile, Commit, ProjectInfo, Task};
use ide_timeline::{kind, Event, NewEvent, Stats};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

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

#[tauri::command]
pub fn task_list(root: PathBuf) -> Result<Vec<Task>, String> {
    tasks::list(&root).map_err(err)
}

/// Cria o worktree `task/<slug>` a partir do HEAD atual.
#[tauri::command]
pub fn task_create(
    app: AppHandle,
    state: State<'_, AppState>,
    root: PathBuf,
    slug: String,
    goal: String,
) -> Result<Task, String> {
    let task = tasks::create(&root, &slug, &goal).map_err(err)?;
    state.record(
        &app,
        NewEvent::new(
            project(&root),
            kind::TASK_CREATE,
            format!("tarefa {slug} criada"),
        )
        .with_data(json!({ "slug": slug, "goal": goal, "base": task.base })),
    );
    Ok(task)
}

#[tauri::command]
pub fn task_diff(root: PathBuf, slug: String) -> Result<String, String> {
    tasks::diff(&root, &slug).map_err(err)
}

/// Integra a tarefa no branch atual com um merge commit; devolve o commit.
#[tauri::command]
pub fn task_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    root: PathBuf,
    slug: String,
) -> Result<String, String> {
    let commit = tasks::merge(&root, &slug).map_err(err)?;
    state.record(
        &app,
        NewEvent::new(
            project(&root),
            kind::TASK_MERGE,
            format!("tarefa {slug} integrada ({commit})"),
        )
        .with_data(json!({ "slug": slug, "commit": commit })),
    );
    Ok(commit)
}

#[tauri::command]
pub fn task_discard(
    app: AppHandle,
    state: State<'_, AppState>,
    root: PathBuf,
    slug: String,
) -> Result<(), String> {
    tasks::discard(&root, &slug).map_err(err)?;
    state.record(
        &app,
        NewEvent::new(
            project(&root),
            kind::TASK_DISCARD,
            format!("tarefa {slug} descartada"),
        )
        .with_data(json!({ "slug": slug })),
    );
    Ok(())
}

fn project(root: &std::path::Path) -> String {
    tasks::main_root(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Chaves de configuração aceitas (evita gravar lixo vindo da UI).
const SETTINGS: [&str; 4] = [
    "budget_usd",
    "sentinel_enabled",
    "sentinel_idle_min",
    "composer",
];

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    check_setting(&key)?;
    state.timeline.get_setting(&key).map_err(err)
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    check_setting(&key)?;
    state.timeline.set_setting(&key, &value).map_err(err)
}

fn check_setting(key: &str) -> Result<(), String> {
    if SETTINGS.contains(&key) {
        Ok(())
    } else {
        Err(format!("configuração desconhecida: {key}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub since: i64,
    pub commits: Vec<Commit>,
    pub tasks: Vec<Task>,
    pub changed: Vec<ChangedFile>,
    pub stats: Stats,
    /// Gasto de hoje em todos os projetos (o orçamento é global).
    pub spent_today: f64,
    pub budget_usd: Option<f64>,
}

/// Resumo do dia do projeto: tudo local, sem chamar o agente.
#[tauri::command]
pub fn daily_brief(state: State<'_, AppState>, root: PathBuf) -> Result<Brief, String> {
    let since_ms = crate::budget::local_midnight_ms();
    let main = tasks::main_root(&root).map_err(err)?;
    Ok(Brief {
        since: since_ms,
        commits: history::commits_since(&main, since_ms / 1000, 50).map_err(err)?,
        tasks: tasks::list(&main).map_err(err)?,
        changed: diff::changed_files(&main).map_err(err)?,
        stats: state
            .timeline
            .stats_since(&project(&main), since_ms)
            .map_err(err)?,
        spent_today: state.timeline.cost_since(since_ms).map_err(err)?,
        budget_usd: crate::budget::budget(&state.timeline),
    })
}
