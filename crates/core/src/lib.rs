//! Núcleo do ide. Tudo aqui deve funcionar sem Tauri, para ser testável
//! e reutilizável pelo servidor MCP (ver `.project/decisions/0001`).

pub mod diff;
pub mod git;
pub mod project;

pub use diff::{ChangedFile, FileStatus};
pub use project::{ProjectInfo, Worktree};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("não é um repositório git: {0}")]
    NotARepo(String),
    #[error("git {args} falhou: {stderr}")]
    Git { args: String, stderr: String },
    #[error("arquivo sem alterações no repositório: {0}")]
    NotChanged(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
