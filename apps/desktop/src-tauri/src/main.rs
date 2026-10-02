// Evita uma janela de console extra no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ide_desktop_lib::run()
}
