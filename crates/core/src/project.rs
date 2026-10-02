use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{git, Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
    /// `None` em HEAD destacado.
    pub branch: Option<String>,
    /// `None` em repositório sem commits.
    pub head: Option<String>,
    pub dirty: bool,
    pub worktrees: Vec<Worktree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}

impl ProjectInfo {
    /// Lê o estado git do projeto que contém `path`.
    pub fn load(path: &Path) -> Result<Self> {
        let root = git::run(path, &["rev-parse", "--show-toplevel"])
            .map(PathBuf::from)
            .map_err(|_| Error::NotARepo(path.display().to_string()))?;

        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let branch = git::run(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
        let head = git::run(&root, &["rev-parse", "--short", "HEAD"]).ok();
        let dirty = !git::run(&root, &["status", "--porcelain"])?.is_empty();
        let worktrees = parse_worktrees(&git::run(&root, &["worktree", "list", "--porcelain"])?);

        Ok(Self {
            root,
            name,
            branch,
            head,
            dirty,
            worktrees,
        })
    }
}

/// Interpreta a saída de `git worktree list --porcelain`.
fn parse_worktrees(porcelain: &str) -> Vec<Worktree> {
    porcelain
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            let mut head = None;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.trim_start_matches("refs/heads/").to_owned());
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    head = Some(h.chars().take(7).collect());
                }
            }
            Some(Worktree {
                path: path?,
                branch,
                head: head.filter(|h: &String| h.chars().any(|c| c != '0')),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        git::run(dir, args).unwrap();
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q", "-b", "main"]);
        git_in(dir.path(), &["config", "user.email", "t@t"]);
        git_in(dir.path(), &["config", "user.name", "t"]);
        git_in(dir.path(), &["config", "core.hooksPath", "/dev/null"]);
        dir
    }

    #[test]
    fn repo_sem_commits() {
        let dir = init_repo();
        let info = ProjectInfo::load(dir.path()).unwrap();
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head, None);
        assert!(!info.dirty);
        assert_eq!(info.worktrees.len(), 1);
    }

    #[test]
    fn detecta_alteracoes_e_worktrees() {
        let dir = init_repo();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        git_in(dir.path(), &["add", "."]);
        git_in(dir.path(), &["commit", "-qm", "chore: init"]);

        let wt = dir.path().join("wt");
        git_in(
            dir.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task/x",
                wt.to_str().unwrap(),
            ],
        );
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();

        let info = ProjectInfo::load(dir.path()).unwrap();
        assert!(info.dirty);
        assert_eq!(info.head.as_ref().map(String::len), Some(7));
        let branches: Vec<_> = info.worktrees.iter().map(|w| w.branch.as_deref()).collect();
        assert_eq!(branches, [Some("main"), Some("task/x")]);
    }

    #[test]
    fn fora_de_repositorio() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            ProjectInfo::load(dir.path()),
            Err(Error::NotARepo(_))
        ));
    }

    #[test]
    fn worktree_destacado() {
        let parsed = parse_worktrees("worktree /a\nHEAD 1234567890abcdef\ndetached\n");
        assert_eq!(
            parsed,
            [Worktree {
                path: "/a".into(),
                branch: None,
                head: Some("1234567".into()),
            }]
        );
    }
}
