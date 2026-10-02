mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::project_info])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app");
}
