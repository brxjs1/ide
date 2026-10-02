//! Alterações do working tree em relação ao HEAD.

use std::path::Path;

use serde::Serialize;

use crate::{git, Error, Result};

/// Hash da árvore vazia do git: base de comparação em repositórios sem commits.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relativo à raiz do repositório.
    pub path: String,
    pub status: FileStatus,
    /// Há alterações no index (staged).
    pub staged: bool,
    /// Caminho anterior, em renomeações.
    pub orig_path: Option<String>,
}

/// Arquivos alterados, inclusive não rastreados, na ordem do `git status`.
pub fn changed_files(root: &Path) -> Result<Vec<ChangedFile>> {
    let out = git::run(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_status(&out))
}

/// Diff unificado de um arquivo contra o HEAD. Só aceita arquivos que aparecem em
/// [`changed_files`], o que impede ler caminhos fora do repositório.
pub fn file_diff(root: &Path, path: &str) -> Result<String> {
    let file = changed_files(root)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| Error::NotChanged(path.to_owned()))?;

    if file.status == FileStatus::Untracked {
        return git::run_with_codes(
            root,
            &[
                "diff",
                "--no-color",
                "--no-index",
                "--",
                null_device(),
                path,
            ],
            &[0, 1],
        );
    }

    let base = if git::run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        "HEAD"
    } else {
        EMPTY_TREE
    };
    let mut args = vec!["diff", "--no-color", "-M", base, "--"];
    if let Some(orig) = &file.orig_path {
        args.push(orig);
    }
    args.push(path);
    git::run(root, &args)
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// Interpreta `git status --porcelain=v1 -z`: entradas `XY caminho\0`, com o caminho
/// de origem em um campo extra quando há renomeação ou cópia.
fn parse_status(out: &str) -> Vec<ChangedFile> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = fields.next() {
        let Some((xy, path)) = entry.split_at_checked(2) else {
            continue;
        };
        let mut chars = xy.chars();
        let (x, y) = (chars.next().unwrap_or(' '), chars.next().unwrap_or(' '));
        let path = path.strip_prefix(' ').unwrap_or(path).to_owned();

        let orig_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            fields.next().map(str::to_owned)
        } else {
            None
        };

        let status = match (x, y) {
            ('?', '?') => FileStatus::Untracked,
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => FileStatus::Conflicted,
            _ => match if x != ' ' { x } else { y } {
                'A' | 'C' => FileStatus::Added,
                'D' => FileStatus::Deleted,
                'R' => FileStatus::Renamed,
                _ => FileStatus::Modified,
            },
        };

        files.push(ChangedFile {
            path,
            status,
            staged: !matches!(x, ' ' | '?'),
            orig_path,
        });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        git::run(dir, args).unwrap();
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "core.hooksPath", "/dev/null"],
        ] {
            git_in(dir.path(), args);
        }
        dir
    }

    #[test]
    fn interpreta_status_porcelain() {
        let files =
            parse_status(" M a.rs\0A  b.rs\0R  novo.rs\0velho.rs\0?? c.txt\0UU d.rs\0 D e.rs\0");
        let summary: Vec<_> = files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.staged, f.orig_path.as_deref()))
            .collect();
        assert_eq!(
            summary,
            [
                ("a.rs", FileStatus::Modified, false, None),
                ("b.rs", FileStatus::Added, true, None),
                ("novo.rs", FileStatus::Renamed, true, Some("velho.rs")),
                ("c.txt", FileStatus::Untracked, false, None),
                ("d.rs", FileStatus::Conflicted, true, None),
                ("e.rs", FileStatus::Deleted, false, None),
            ]
        );
    }

    #[test]
    fn diff_de_arquivo_modificado_e_nao_rastreado() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "um\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-qm", "init"]);
        std::fs::write(root.join("a.txt"), "um\ndois\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/novo.txt"), "oi\n").unwrap();

        let files = changed_files(root).unwrap();
        let paths: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.status)).collect();
        assert_eq!(
            paths,
            [
                ("a.txt", FileStatus::Modified),
                ("src/novo.txt", FileStatus::Untracked)
            ]
        );

        assert!(file_diff(root, "a.txt").unwrap().contains("+dois"));
        assert!(file_diff(root, "src/novo.txt").unwrap().contains("+oi"));
    }

    #[test]
    fn diff_em_repositorio_sem_commits() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        git_in(dir.path(), &["add", "."]);
        assert!(file_diff(dir.path(), "a.txt").unwrap().contains("+x"));
    }

    #[test]
    fn recusa_caminho_fora_das_alteracoes() {
        let dir = repo();
        assert!(matches!(
            file_diff(dir.path(), "../../etc/passwd"),
            Err(Error::NotChanged(_))
        ));
    }
}
