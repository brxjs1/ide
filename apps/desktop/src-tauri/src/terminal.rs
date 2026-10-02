use std::path::PathBuf;

use ide_pty::SpawnOptions;
use ide_timeline::{kind, NewEvent};
use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::state::{err, AppState};

/// Abre o shell do usuário em `cwd`. A saída vai em bytes brutos por `on_data`
/// (ArrayBuffer no frontend) e o código de saída por `on_exit`.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: PathBuf,
    rows: u16,
    cols: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, String> {
    let project = cwd.to_string_lossy().into_owned();
    let exit_app = app.clone();
    let exit_project = project.clone();

    let id = state
        .pty
        .spawn(
            SpawnOptions {
                cwd: Some(cwd),
                rows,
                cols,
                ..Default::default()
            },
            move |bytes| {
                let _ = on_data.send(InvokeResponseBody::Raw(bytes));
            },
            move |code| {
                // try_state: a thread pode terminar depois do app começar a fechar.
                let Some(state) = exit_app.try_state::<AppState>() else {
                    return;
                };
                state.record(
                    &exit_app,
                    NewEvent::new(
                        exit_project,
                        kind::TERMINAL_EXIT,
                        format!("terminal encerrado ({code})"),
                    )
                    .with_data(json!({ "code": code })),
                );
                let _ = on_exit.send(code);
            },
        )
        .map_err(err)?;

    state.record(
        &app,
        NewEvent::new(project, kind::TERMINAL_START, "terminal aberto")
            .with_data(json!({ "id": id })),
    );
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    state.pty.write(id, data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    state.pty.resize(id, rows, cols).map_err(err)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    state.pty.kill(id).map_err(err)
}
