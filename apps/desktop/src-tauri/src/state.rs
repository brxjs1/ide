use std::collections::HashMap;
use std::sync::Mutex;

use ide_agent::AgentProcess;
use ide_pty::PtyManager;
use ide_timeline::{Event, NewEvent, Timeline};
use tauri::{AppHandle, Emitter};

pub struct AppState {
    pub pty: PtyManager,
    pub timeline: Timeline,
    pub agent: Mutex<AgentSlot>,
    /// promptId → projeto (raiz), para gravar os eventos do agente na timeline certa.
    pub prompts: Mutex<HashMap<String, String>>,
}

/// Processo do agente atual. `generation` evita que o aviso de saída de um processo
/// antigo limpe um processo novo iniciado depois.
#[derive(Default)]
pub struct AgentSlot {
    pub process: Option<AgentProcess>,
    pub generation: u64,
}

impl AppState {
    pub fn new(timeline: Timeline) -> Self {
        Self {
            pty: PtyManager::new(),
            timeline,
            agent: Mutex::default(),
            prompts: Mutex::default(),
        }
    }

    /// Grava o evento e avisa a UI. Falha de gravação não interrompe o fluxo principal.
    pub fn record(&self, app: &AppHandle, event: NewEvent) {
        match self.timeline.append(event) {
            Ok(saved) => {
                let _ = app.emit::<Event>("timeline://new", saved);
            }
            Err(e) => eprintln!("timeline: {e}"),
        }
    }
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
