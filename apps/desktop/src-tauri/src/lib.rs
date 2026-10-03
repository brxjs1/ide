mod agent;
mod budget;
mod commands;
mod editor;
mod state;
mod terminal;

use tauri::Manager;

use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let timeline = ide_timeline::Timeline::open(&dir.join("timeline.db"))?;
            app.manage(AppState::new(timeline));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project_info,
            commands::changed_files,
            commands::file_diff,
            commands::timeline_list,
            commands::task_list,
            commands::task_create,
            commands::task_diff,
            commands::task_merge,
            commands::task_discard,
            commands::settings_get,
            commands::settings_set,
            commands::daily_brief,
            editor::files_tree,
            editor::file_read,
            editor::file_write,
            editor::file_outline,
            editor::lsp_open,
            editor::lsp_change,
            editor::lsp_save,
            editor::lsp_close,
            editor::lsp_hover,
            editor::lsp_definition,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            agent::agent_send,
            agent::agent_stop,
        ])
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                editor::shutdown(app);
            }
        });
}
