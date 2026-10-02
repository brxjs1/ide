//! Timeline de desenvolvimento: tudo que o agente e os terminais fazem, por projeto,
//! em um SQLite local. Base para checkpoints e para o resumo diário.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Tipos de evento conhecidos. Strings para o esquema aceitar novos tipos sem migração.
pub mod kind {
    pub const AGENT_PROMPT: &str = "agent.prompt";
    pub const AGENT_TOOL: &str = "agent.tool";
    pub const AGENT_DONE: &str = "agent.done";
    pub const AGENT_ERROR: &str = "agent.error";
    pub const TERMINAL_START: &str = "terminal.start";
    pub const TERMINAL_EXIT: &str = "terminal.exit";
    pub const TASK_CREATE: &str = "task.create";
    pub const TASK_MERGE: &str = "task.merge";
    pub const TASK_DISCARD: &str = "task.discard";
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    /// Milissegundos desde a época Unix.
    pub ts: i64,
    pub project: String,
    pub kind: String,
    pub summary: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct NewEvent {
    pub project: String,
    pub kind: String,
    pub summary: String,
    pub data: serde_json::Value,
}

impl NewEvent {
    pub fn new(project: impl Into<String>, kind: &str, summary: impl Into<String>) -> Self {
        Self {
            project: project.into(),
            kind: kind.into(),
            summary: summary.into(),
            data: serde_json::Value::Null,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = data;
        self
    }
}

pub struct Timeline {
    conn: Mutex<Connection>,
}

const MIGRATIONS: &[&str] = &["CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        project TEXT    NOT NULL,
        kind    TEXT    NOT NULL,
        summary TEXT    NOT NULL,
        data    TEXT    NOT NULL DEFAULT 'null'
    );
    CREATE INDEX events_project_id ON events (project, id DESC);"];

impl Timeline {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let tx = conn.transaction()?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", i + 1)?;
        }
        tx.commit()?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn append(&self, event: NewEvent) -> Result<Event> {
        let ts = now_ms();
        let data = serde_json::to_string(&event.data)?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO events (ts, project, kind, summary, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ts, event.project, event.kind, event.summary, data],
        )?;
        Ok(Event {
            id: conn.last_insert_rowid(),
            ts,
            project: event.project,
            kind: event.kind,
            summary: event.summary,
            data: event.data,
        })
    }

    /// Eventos do projeto, do mais recente para o mais antigo. `before` pagina por id.
    pub fn list(&self, project: &str, limit: u32, before: Option<i64>) -> Result<Vec<Event>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, ts, project, kind, summary, data FROM events
             WHERE project = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![project, before.unwrap_or(i64::MAX), limit], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        rows.map(|row| {
            let (id, ts, project, kind, summary, data) = row?;
            Ok(Event {
                id,
                ts,
                project,
                kind,
                summary,
                data: serde_json::from_str(&data)?,
            })
        })
        .collect()
    }

    pub fn get(&self, id: i64) -> Result<Option<Event>> {
        let conn = self.lock();
        let row = conn
            .query_row(
                "SELECT id, ts, project, kind, summary, data FROM events WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(id, ts, project, kind, summary, data)| {
            Ok(Event {
                id,
                ts,
                project,
                kind,
                summary,
                data: serde_json::from_str(&data)?,
            })
        })
        .transpose()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn grava_e_lista_por_projeto_do_mais_recente() {
        let tl = Timeline::open_in_memory().unwrap();
        tl.append(NewEvent::new("/a", kind::AGENT_PROMPT, "primeiro"))
            .unwrap();
        tl.append(NewEvent::new("/b", kind::AGENT_PROMPT, "outro projeto"))
            .unwrap();
        let last = tl
            .append(
                NewEvent::new("/a", kind::AGENT_DONE, "segundo").with_data(json!({"costUsd": 0.5})),
            )
            .unwrap();

        let events = tl.list("/a", 10, None).unwrap();
        let summaries: Vec<_> = events.iter().map(|e| e.summary.as_str()).collect();
        assert_eq!(summaries, ["segundo", "primeiro"]);
        assert_eq!(events[0], last);
        assert_eq!(events[0].data["costUsd"], 0.5);
    }

    #[test]
    fn pagina_com_before_e_limit() {
        let tl = Timeline::open_in_memory().unwrap();
        let ids: Vec<_> = (0..5)
            .map(|i| {
                tl.append(NewEvent::new("/a", kind::AGENT_TOOL, format!("e{i}")))
                    .unwrap()
                    .id
            })
            .collect();

        let page = tl.list("/a", 2, Some(ids[3])).unwrap();
        let summaries: Vec<_> = page.iter().map(|e| e.summary.as_str()).collect();
        assert_eq!(summaries, ["e2", "e1"]);
    }

    #[test]
    fn reabre_arquivo_sem_reaplicar_migracoes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let id = Timeline::open(&path)
            .unwrap()
            .append(NewEvent::new("/a", kind::TERMINAL_START, "sh"))
            .unwrap()
            .id;

        let reopened = Timeline::open(&path).unwrap();
        assert_eq!(reopened.get(id).unwrap().unwrap().summary, "sh");
        assert!(reopened.get(id + 1).unwrap().is_none());
    }
}
