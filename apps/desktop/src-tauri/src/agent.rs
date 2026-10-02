use ide_agent::{AgentEvent, AgentProcess, Inbound, Outbound, SidecarCommand};
use ide_timeline::{kind, NewEvent};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{err, AppState};

const MESSAGE_EVENT: &str = "agent://message";
const EXIT_EVENT: &str = "agent://exit";

/// Envia uma mensagem ao agente, iniciando o sidecar na primeira vez. As respostas
/// chegam à UI pelo evento `agent://message`.
#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AppState>,
    message: Inbound,
) -> Result<(), String> {
    if let Inbound::Prompt {
        id,
        text,
        cwd,
        mode,
        ..
    } = &message
    {
        lock(&state.prompts).insert(id.clone(), cwd.clone());
        state.record(
            &app,
            NewEvent::new(cwd.clone(), kind::AGENT_PROMPT, truncate(text, 140))
                .with_data(json!({ "promptId": id, "mode": mode })),
        );
    }

    let mut slot = lock(&state.agent);
    if slot.process.is_none() {
        slot.generation += 1;
        let generation = slot.generation;
        let command = SidecarCommand::locate().map_err(err)?;
        let on_message = {
            let app = app.clone();
            move |msg: Outbound| {
                record_outbound(&app, &msg);
                let _ = app.emit(MESSAGE_EVENT, msg);
            }
        };
        let on_exit = {
            let app = app.clone();
            move |code: Option<i32>| {
                if let Some(state) = app.try_state::<AppState>() {
                    let mut slot = lock(&state.agent);
                    if slot.generation == generation {
                        slot.process = None;
                        // Pedidos em andamento morreram com o processo.
                        lock(&state.prompts).clear();
                    }
                }
                let _ = app.emit(EXIT_EVENT, code);
            }
        };
        slot.process = Some(AgentProcess::spawn(&command, on_message, on_exit).map_err(err)?);
    }

    slot.process
        .as_ref()
        .expect("processo acabou de ser iniciado")
        .send(&message)
        .map_err(err)
}

/// Encerra o sidecar. A sessão é retomável: o próximo prompt inicia outro processo.
#[tauri::command]
pub fn agent_stop(state: State<'_, AppState>) {
    let process = lock(&state.agent).process.take();
    if let Some(process) = process {
        process.stop();
    }
}

fn record_outbound(app: &AppHandle, msg: &Outbound) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let project = |prompt_id: &str| lock(&state.prompts).get(prompt_id).cloned();

    let event = match msg {
        Outbound::Event {
            prompt_id,
            event: AgentEvent::ToolUse { name, input, .. },
        } => project(prompt_id).map(|p| {
            NewEvent::new(p, kind::AGENT_TOOL, tool_summary(name, input))
                .with_data(json!({ "promptId": prompt_id, "tool": name, "input": input }))
        }),
        Outbound::Done {
            prompt_id,
            is_error,
            cost_usd,
            duration_ms,
            ..
        } => {
            let p = lock(&state.prompts).remove(prompt_id);
            p.map(|p| {
                let secs = duration_ms.map(|ms| format!(" em {:.1}s", ms / 1000.0)).unwrap_or_default();
                let cost = cost_usd.map(|c| format!(" · US$ {c:.4}")).unwrap_or_default();
                let what = if *is_error { "terminou com erro" } else { "concluído" };
                NewEvent::new(p, kind::AGENT_DONE, format!("{what}{secs}{cost}")).with_data(json!({
                    "promptId": prompt_id, "isError": is_error, "costUsd": cost_usd, "durationMs": duration_ms
                }))
            })
        }
        Outbound::Error {
            prompt_id: Some(prompt_id),
            message,
        } => project(prompt_id).map(|p| {
            NewEvent::new(p, kind::AGENT_ERROR, truncate(message, 140))
                .with_data(json!({ "promptId": prompt_id }))
        }),
        _ => None,
    };

    if let Some(event) = event {
        state.record(app, event);
    }
}

/// "Read src/main.rs", "Bash cargo test"... usando o campo mais descritivo do input.
fn tool_summary(name: &str, input: &serde_json::Value) -> String {
    const KEYS: [&str; 6] = [
        "file_path",
        "command",
        "pattern",
        "path",
        "url",
        "description",
    ];
    let detail = KEYS
        .iter()
        .find_map(|k| input.get(k).and_then(|v| v.as_str()));
    match detail {
        Some(d) => truncate(&format!("{name} {d}"), 140),
        None => name.to_owned(),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or_default();
    if line.chars().count() <= max && line.len() == text.len() {
        return line.to_owned();
    }
    let cut: String = line.chars().take(max).collect();
    format!("{cut}…")
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_ferramentas() {
        assert_eq!(
            tool_summary("Read", &json!({"file_path": "a.rs"})),
            "Read a.rs"
        );
        assert_eq!(
            tool_summary("Bash", &json!({"command": "cargo test"})),
            "Bash cargo test"
        );
        assert_eq!(
            tool_summary("TodoWrite", &json!({"todos": []})),
            "TodoWrite"
        );
    }

    #[test]
    fn trunca_na_primeira_linha() {
        assert_eq!(truncate("curto", 10), "curto");
        assert_eq!(truncate("linha 1\nlinha 2", 50), "linha 1…");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
