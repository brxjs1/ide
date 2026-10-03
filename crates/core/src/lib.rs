//! Núcleo do ide. Tudo aqui deve funcionar sem Tauri, para ser testável
//! e reutilizável pelo servidor MCP (ver `.project/decisions/0001`).

pub mod board;
pub mod diff;
pub mod files;
pub mod git;
pub mod history;
pub mod project;
pub mod tasks;

pub use diff::{ChangedFile, FileStatus};
pub use history::Commit;
pub use project::{ProjectInfo, Worktree};
pub use tasks::Task;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("não é um repositório git: {0}")]
    NotARepo(String),
    #[error("git {args} falhou: {stderr}")]
    Git { args: String, stderr: String },
    #[error("a tarefa {0} não está no quadro")]
    BoardTaskNotFound(String),
    #[error("caminho fora do projeto: {0}")]
    OutsideRoot(String),
    #[error("arquivo grande demais para o editor ({0} bytes)")]
    TooLarge(u64),
    #[error("arquivo binário: {0}")]
    Binary(String),
    #[error("arquivo sem alterações no repositório: {0}")]
    NotChanged(String),
    #[error("nome de tarefa inválido: {0:?} (use a-z, 0-9 e -, até 50 caracteres)")]
    InvalidSlug(String),
    #[error("a tarefa {0} já existe")]
    TaskExists(String),
    #[error("a tarefa {0} não existe")]
    TaskNotFound(String),
    #[error("o repositório não tem commits; crie um antes de abrir tarefas")]
    NoCommits,
    #[error("a tarefa {0} tem alterações não commitadas")]
    TaskDirty(String),
    #[error("o branch atual tem alterações não commitadas; commite ou guarde antes de integrar")]
    MainDirty,
    #[error("a tarefa {0} não tem commits para integrar")]
    NothingToMerge(String),
    #[error("a tarefa altera arquivos do quadro que o app mudou no checkout ({0}); commite o quadro ou desfaça a mudança deles antes de integrar")]
    BoardConflict(String),
    #[error("conflito ao integrar a tarefa (merge abortado): {0}")]
    MergeConflict(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
