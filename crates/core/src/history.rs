//! Histórico recente do repositório (resumo do dia).

use std::path::Path;

use serde::Serialize;

use crate::{git, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// Segundos desde a época Unix (data do commit).
    pub time: i64,
    pub merge: bool,
}

/// Commits do branch atual a partir de `since` (segundos Unix), do mais novo ao mais antigo.
pub fn commits_since(root: &Path, since: i64, limit: u32) -> Result<Vec<Commit>> {
    // Repositório sem commits não tem histórico.
    if git::run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let since_arg = format!("--since=@{since}");
    let limit_arg = format!("--max-count={limit}");
    let mut args = vec![
        "log",
        &limit_arg,
        // Filhos antes dos pais mesmo com commits no mesmo segundo.
        "--topo-order",
        // Separador de unidade (0x1f) e de registro (0x1e): seguros em assuntos.
        "--format=%h%x1f%s%x1f%an%x1f%ct%x1f%p%x1e",
    ];
    // O git não lê "@0" como a época 0 (vira uma data perto de agora): sem limite, então.
    if since > 0 {
        args.push(&since_arg);
    }
    let out = git::run(root, &args)?;
    Ok(out
        .split('\x1e')
        .filter_map(|record| {
            let mut f = record.trim_start_matches('\n').split('\x1f');
            let hash = f.next()?.to_owned();
            if hash.is_empty() {
                return None;
            }
            Some(Commit {
                hash,
                subject: f.next()?.to_owned(),
                author: f.next()?.to_owned(),
                time: f.next()?.parse().ok()?,
                merge: f.next()?.split_whitespace().count() > 1,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        git::run(dir, args).unwrap();
    }

    #[test]
    fn lista_commits_recentes_com_merge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "Ana"],
            &["config", "core.hooksPath", "/dev/null"],
        ] {
            git_in(root, args);
        }
        assert!(commits_since(root, 0, 10).unwrap().is_empty());

        std::fs::write(root.join("a"), "1").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-qm", "feat: um | com separadores"]);
        git_in(root, &["checkout", "-qb", "x"]);
        std::fs::write(root.join("b"), "2").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-qm", "feat: dois"]);
        git_in(root, &["checkout", "-q", "main"]);
        git_in(root, &["merge", "-q", "--no-ff", "-m", "Merge x", "x"]);

        let commits = commits_since(root, 0, 10).unwrap();
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(
            subjects,
            ["Merge x", "feat: dois", "feat: um | com separadores"]
        );
        assert!(commits[0].merge && !commits[1].merge);
        assert_eq!(commits[0].author, "Ana");
        assert_eq!(commits_since(root, 0, 1).unwrap().len(), 1);

        let oldest = commits.last().unwrap().time;
        assert_eq!(commits_since(root, oldest, 10).unwrap().len(), 3);
        assert!(commits_since(root, commits[0].time + 3600, 10)
            .unwrap()
            .is_empty());
    }
}
