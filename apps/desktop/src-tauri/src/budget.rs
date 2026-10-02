//! Orçamento diário do agente. Vale para todos os projetos e corta a Sentinela
//! (conversas `watch:*`) quando o gasto de hoje chega ao limite.

use chrono::{Local, TimeZone};
use ide_timeline::Timeline;

/// Prefixo das conversas em background, que respeitam o orçamento.
pub const BACKGROUND_PREFIX: &str = "watch:";

/// Meia-noite de hoje no fuso local, em milissegundos Unix.
pub fn local_midnight_ms() -> i64 {
    let now = Local::now();
    now.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|midnight| Local.from_local_datetime(&midnight).earliest())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|| now.timestamp_millis())
}

/// Orçamento em US$ (ausente, inválido ou zero = sem limite).
pub fn budget(timeline: &Timeline) -> Option<f64> {
    timeline
        .get_setting("budget_usd")
        .ok()
        .flatten()
        .and_then(|v| v.trim().replace(',', ".").parse::<f64>().ok())
        .filter(|b| *b > 0.0)
}

/// Erro se a conversa é de background e o orçamento de hoje acabou.
pub fn check(timeline: &Timeline, conversation: &str) -> Result<(), String> {
    if !conversation.starts_with(BACKGROUND_PREFIX) {
        return Ok(());
    }
    let Some(limit) = budget(timeline) else {
        return Ok(());
    };
    let spent = timeline
        .cost_since(local_midnight_ms())
        .map_err(|e| e.to_string())?;
    if spent >= limit {
        return Err(format!(
            "orçamento diário atingido (US$ {spent:.2} de US$ {limit:.2}); a Sentinela volta amanhã"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ide_timeline::{kind, NewEvent};
    use serde_json::json;

    use super::*;

    #[test]
    fn so_background_e_cortado_quando_o_orcamento_acaba() {
        let tl = Timeline::open_in_memory().unwrap();
        assert!(
            check(&tl, "watch:main").is_ok(),
            "sem orçamento, sem limite"
        );

        tl.set_setting("budget_usd", "0,50").unwrap();
        assert_eq!(budget(&tl), Some(0.5));
        tl.append(NewEvent::new("/p", kind::AGENT_DONE, "ok").with_data(json!({ "costUsd": 0.3 })))
            .unwrap();
        assert!(check(&tl, "watch:main").is_ok());

        tl.append(
            NewEvent::new("/p", kind::AGENT_DONE, "ok").with_data(json!({ "costUsd": 0.25 })),
        )
        .unwrap();
        assert!(check(&tl, "watch:main").unwrap_err().contains("orçamento"));
        assert!(
            check(&tl, "t:1").is_ok(),
            "conversas interativas não são cortadas"
        );

        tl.set_setting("budget_usd", "0").unwrap();
        assert!(check(&tl, "watch:main").is_ok());
    }

    #[test]
    fn meia_noite_local_e_hoje() {
        let midnight = local_midnight_ms();
        let now = Local::now().timestamp_millis();
        assert!(midnight <= now && now - midnight < 25 * 3600 * 1000);
    }
}
