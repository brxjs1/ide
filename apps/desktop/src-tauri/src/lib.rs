mod agent;
mod commands;
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
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            agent::agent_send,
            agent::agent_stop,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app");
}
