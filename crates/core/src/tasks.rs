//! Tarefas autônomas: cada uma é um git worktree em `../<repo>.worktrees/<slug>` no
//! branch `task/<slug>` (mesma convenção de `scripts/worktree.sh`). O objetivo e o
//! commit base ficam na config do branch, então não há estado fora do git.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::diff::{self, FileStatus};
use crate::{git, Error, ProjectInfo, Result};

pub const BRANCH_PREFIX: &str = "task/";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub slug: String,
    pub branch: String,
    pub path: PathBuf,
    pub goal: Option<String>,
    /// Commit de onde a tarefa partiu (base do diff e da contagem de commits).
    pub base: Option<String>,
    /// Commits da tarefa desde a base.
    pub ahead: u32,
    /// Alterações não commitadas no worktree da tarefa.
    pub dirty: bool,
}

pub fn validate_slug(slug: &str) -> Result<()> {
    let ok = !slug.is_empty()
        && slug.len() <= 50
        && slug.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidSlug(slug.to_owned()))
    }
}

/// Raiz do worktree principal, mesmo quando `path` está dentro de um worktree de tarefa.
pub fn main_root(path: &Path) -> Result<PathBuf> {
    let common = git::run(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .map_err(|_| Error::NotARepo(path.display().to_string()))?;
    PathBuf::from(common)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| Error::NotARepo(path.display().to_string()))
}

fn worktrees_dir(main: &Path) -> PathBuf {
    let name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    main.with_file_name(format!("{name}.worktrees"))
}

pub fn create(root: &Path, slug: &str, goal: &str) -> Result<Task> {
    validate_slug(slug)?;
    let main = main_root(root)?;
    let branch = format!("{BRANCH_PREFIX}{slug}");
    let path = worktrees_dir(&main).join(slug);
    let branch_exists = git::run(&main, &["rev-parse", "--verify", "--quiet", &branch]).is_ok();
    if path.exists() || branch_exists {
        return Err(Error::TaskExists(slug.to_owned()));
    }
    let base = git::run(&main, &["rev-parse", "HEAD"]).map_err(|_| Error::NoCommits)?;

    std::fs::create_dir_all(worktrees_dir(&main))?;
    let path_str = path.to_string_lossy().into_owned();
    git::run(
        &main,
        &["worktree", "add", "-q", "-b", &branch, &path_str, &base],
    )?;
    // `--` antes da chave: um objetivo começando com "-" não pode virar opção do git.
    git::run(
        &main,
        &[
            "config",
            "--",
            &format!("branch.{branch}.description"),
            goal,
        ],
    )?;
    git::run(
        &main,
        &["config", "--", &format!("branch.{branch}.idebase"), &base],
    )?;

    get(root, slug)
}

pub fn list(root: &Path) -> Result<Vec<Task>> {
    let main = main_root(root)?;
    ProjectInfo::load(&main)?
        .worktrees
        .into_iter()
        .filter_map(|w| {
            let slug = w.branch.as_deref()?.strip_prefix(BRANCH_PREFIX)?.to_owned();
            Some((slug, w.path))
        })
        .map(|(slug, path)| describe(&main, slug, path))
        .collect()
}

pub fn get(root: &Path, slug: &str) -> Result<Task> {
    validate_slug(slug)?;
    list(root)?
        .into_iter()
        .find(|t| t.slug == slug)
        .ok_or_else(|| Error::TaskNotFound(slug.to_owned()))
}

fn describe(main: &Path, slug: String, path: PathBuf) -> Result<Task> {
    let branch = format!("{BRANCH_PREFIX}{slug}");
    let config = |key: &str| {
        git::run(
            main,
            &["config", "--get", &format!("branch.{branch}.{key}")],
        )
        .ok()
        .filter(|v| !v.is_empty())
    };
    let goal = config("description");
    let base = config("idebase");
    let ahead = match &base {
        Some(base) => git::run(main, &["rev-list", "--count", &format!("{base}..{branch}")])?
            .parse()
            .unwrap_or(0),
        None => 0,
    };
    let dirty = !git::run(&path, &["status", "--porcelain"])?.is_empty();
    Ok(Task {
        slug,
        branch,
        path,
        goal,
        base,
        ahead,
        dirty,
    })
}

/// Tudo que a tarefa mudou desde a base: commits, alterações pendentes e arquivos novos.
pub fn diff(root: &Path, slug: &str) -> Result<String> {
    let task = get(root, slug)?;
    let base = task.base.as_deref().unwrap_or("HEAD");
    let mut out = git::run(&task.path, &["diff", "--no-color", "-M", base])?;
    for file in diff::changed_files(&task.path)? {
        if file.status == FileStatus::Untracked {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&diff::file_diff(&task.path, &file.path)?);
        }
    }
    Ok(out)
}

/// Integra a tarefa no branch atual do worktree principal com um merge commit.
/// Em conflito, aborta o merge e devolve o erro — o worktree principal fica como estava.
pub fn merge(root: &Path, slug: &str) -> Result<String> {
    let task = get(root, slug)?;
    if task.dirty {
        return Err(Error::TaskDirty(slug.to_owned()));
    }
    if task.ahead == 0 {
        return Err(Error::NothingToMerge(slug.to_owned()));
    }
    let main = main_root(root)?;
    // O quadro (.project/tasks/) é atualizado pelo app no checkout principal enquanto a
    // tarefa roda (status, worktree): isso não bloqueia o merge — a não ser que o branch
    // também mude um desses arquivos, e aí o git recusaria. Melhor dizer antes, e quais.
    let (board, outside): (Vec<String>, Vec<String>) = dirty_paths(&main)?
        .into_iter()
        .partition(|p| p.starts_with(&format!("{}/", crate::board::DIR)));
    if !outside.is_empty() {
        return Err(Error::MainDirty);
    }
    if !board.is_empty() {
        let changed = git::run(
            &main,
            &[
                "diff",
                "--name-only",
                "-z",
                &format!("HEAD...{}", task.branch),
            ],
        )?;
        let both: Vec<String> = changed
            .split('\0')
            .filter(|p| board.iter().any(|b| b == p))
            .map(str::to_owned)
            .collect();
        if !both.is_empty() {
            return Err(Error::BoardConflict(both.join(", ")));
        }
    }

    let message = match &task.goal {
        Some(goal) => format!(
            "Merge {}: {}",
            task.branch,
            goal.lines().next().unwrap_or_default()
        ),
        None => format!("Merge {}", task.branch),
    };
    if let Err(e) = git::run(&main, &["merge", "--no-ff", "-m", &message, &task.branch]) {
        let _ = git::run(&main, &["merge", "--abort"]);
        return Err(Error::MergeConflict(e.to_string()));
    }
    git::run(&main, &["rev-parse", "--short", "HEAD"])
}

/// Arquivos versionados alterados no checkout.
/// `-z`: caminhos crus separados por NUL (sem aspas nem ambiguidade com " -> "); num
/// rename vêm destino e origem, e os dois contam.
fn dirty_paths(main: &Path) -> Result<Vec<String>> {
    let status = git::run(
        main,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    )?;
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    let mut dirty = Vec::new();
    while let Some(entry) = entries.next() {
        let code = entry.get(..2).unwrap_or_default();
        let mut paths = vec![entry.get(3..).unwrap_or_default().to_owned()];
        if code.contains('R') || code.contains('C') {
            paths.extend(entries.next().map(str::to_owned));
        }
        dirty.extend(paths);
    }
    Ok(dirty)
}

/// Remove o worktree e o branch da tarefa (com a config do branch).
pub fn discard(root: &Path, slug: &str) -> Result<()> {
    let task = get(root, slug)?;
    let main = main_root(root)?;
    let path = task.path.to_string_lossy().into_owned();
    git::run(&main, &["worktree", "remove", "--force", &path])?;
    git::run(&main, &["branch", "-D", &task.branch])?;
    Ok(())
}

/// `path` está dentro de um worktree de tarefa (e não no worktree principal)?
/// É a trava que libera o modo de autonomia total.
pub fn is_task_worktree(path: &Path) -> bool {
    let Ok(info) = ProjectInfo::load(path) else {
        return false;
    };
    let Ok(main) = main_root(path) else {
        return false;
    };
    let is_task_branch = info
        .branch
        .as_deref()
        .is_some_and(|b| b.starts_with(BRANCH_PREFIX));
    is_task_branch && same_path(&info.root, &main).is_some_and(|same| !same)
}

fn same_path(a: &Path, b: &Path) -> Option<bool> {
    Some(a.canonicalize().ok()? == b.canonicalize().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        git::run(dir, args).unwrap();
    }

    /// Repositório em `<tmp>/repo` com um commit; o worktree das tarefas fica ao lado.
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "core.hooksPath", "/dev/null"],
        ] {
            git_in(&root, args);
        }
        std::fs::write(root.join("a.txt"), "um\n").unwrap();
        git_in(&root, &["add", "."]);
        git_in(&root, &["commit", "-qm", "init"]);
        (tmp, root)
    }

    fn commit_in(dir: &Path, file: &str, content: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-qm", "mudança"]);
    }

    #[test]
    fn valida_slug() {
        for ok in ["x", "fix-login", "a1-b2"] {
            assert!(validate_slug(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-x", "Maiuscula", "a b", "../x", "a/b", &"x".repeat(51)] {
            assert!(validate_slug(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cria_lista_e_descreve() {
        let (tmp, root) = repo();
        let task = create(&root, "login", "Adicionar login\ncom critérios").unwrap();

        assert_eq!(task.branch, "task/login");
        assert_eq!(task.path, tmp.path().join("repo.worktrees/login"));
        assert_eq!(task.goal.as_deref(), Some("Adicionar login\ncom critérios"));
        assert_eq!(task.ahead, 0);
        assert!(!task.dirty);
        assert!(matches!(
            create(&root, "login", "de novo"),
            Err(Error::TaskExists(_))
        ));

        commit_in(&task.path, "b.txt", "novo\n");
        std::fs::write(task.path.join("c.txt"), "pendente\n").unwrap();
        let task = get(&root, "login").unwrap();
        assert_eq!(task.ahead, 1);
        assert!(task.dirty);
        // Listar a partir do worktree da tarefa enxerga o mesmo conjunto.
        assert_eq!(list(&task.path).unwrap(), list(&root).unwrap());
    }

    #[test]
    fn objetivo_comecando_com_hifen_nao_vira_opcao() {
        let (_tmp, root) = repo();
        let task = create(&root, "x", "--unset-all").unwrap();
        assert_eq!(task.goal.as_deref(), Some("--unset-all"));
    }

    #[test]
    fn diff_inclui_commits_e_arquivos_novos() {
        let (_tmp, root) = repo();
        let task = create(&root, "x", "objetivo").unwrap();
        commit_in(&task.path, "a.txt", "um\ndois\n");
        std::fs::write(task.path.join("novo.txt"), "oi\n").unwrap();

        let out = diff(&root, "x").unwrap();
        assert!(out.contains("+dois"), "{out}");
        assert!(out.contains("+oi"), "{out}");
    }

    #[test]
    fn integra_com_merge_commit() {
        let (_tmp, root) = repo();
        let task = create(&root, "x", "Melhorar a\nlinha 2").unwrap();
        assert!(matches!(merge(&root, "x"), Err(Error::NothingToMerge(_))));

        commit_in(&task.path, "b.txt", "b\n");
        std::fs::write(task.path.join("sujo.txt"), "x").unwrap();
        assert!(matches!(merge(&root, "x"), Err(Error::TaskDirty(_))));
        std::fs::remove_file(task.path.join("sujo.txt")).unwrap();

        std::fs::write(root.join("a.txt"), "local\n").unwrap();
        assert!(matches!(merge(&root, "x"), Err(Error::MainDirty)));
        git_in(&root, &["checkout", "--", "a.txt"]);

        // O quadro mudou no checkout principal (status da tarefa): não bloqueia.
        let board = crate::board::create(
            &root,
            "Melhorar a linha",
            crate::board::Status::Todo,
            None,
            None,
        )
        .unwrap();
        git_in(&root, &["add", "."]);
        git_in(&root, &["commit", "-qm", "quadro"]);
        crate::board::set_status(&root, &board.slug, crate::board::Status::Doing).unwrap();
        // ...mas um arquivo com nome parecido, fora da pasta, bloqueia.
        std::fs::write(root.join(".project/tasks.md"), "x").unwrap();
        git_in(&root, &["add", ".project/tasks.md"]);
        git_in(&root, &["commit", "-qm", "parecido"]);
        std::fs::write(root.join(".project/tasks.md"), "mudou").unwrap();
        assert!(matches!(merge(&root, "x"), Err(Error::MainDirty)));
        git_in(&root, &["checkout", "--", ".project/tasks.md"]);
        // Rename de fora para dentro do quadro também bloqueia.
        git_in(&root, &["mv", "a.txt", ".project/tasks/a.md"]);
        assert!(matches!(merge(&root, "x"), Err(Error::MainDirty)));
        git_in(&root, &["mv", ".project/tasks/a.md", "a.txt"]);

        merge(&root, "x").unwrap();
        assert!(root.join("b.txt").exists());
        let subject = git::run(&root, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, "Merge task/x: Melhorar a");
    }

    #[test]
    fn branch_que_muda_o_quadro_sujo_falha_antes_do_merge() {
        let (_tmp, root) = repo();
        let board =
            crate::board::create(&root, "Tarefa", crate::board::Status::Todo, None, None).unwrap();
        git_in(&root, &["add", "."]);
        git_in(&root, &["commit", "-qm", "quadro"]);
        let task = create(&root, "x", "objetivo").unwrap();
        // O agente mexeu no arquivo da tarefa no branch, e o app também, no checkout.
        commit_in(&task.path, &board.path, "# Tarefa\n\n- Status: concluída\n");
        crate::board::set_status(&root, &board.slug, crate::board::Status::Doing).unwrap();
        match merge(&root, "x") {
            Err(Error::BoardConflict(files)) => assert_eq!(files, board.path),
            other => panic!("esperava BoardConflict, veio {other:?}"),
        }
        // Nada foi integrado e o quadro local ficou como estava.
        assert!(
            crate::board::get(&root, &board.slug).unwrap().status == crate::board::Status::Doing
        );
    }

    #[test]
    fn conflito_aborta_e_preserva_o_principal() {
        let (_tmp, root) = repo();
        let task = create(&root, "x", "g").unwrap();
        commit_in(&task.path, "a.txt", "da tarefa\n");
        commit_in(&root, "a.txt", "do principal\n");
        let head = git::run(&root, &["rev-parse", "HEAD"]).unwrap();

        assert!(matches!(merge(&root, "x"), Err(Error::MergeConflict(_))));
        assert_eq!(git::run(&root, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(git::run(&root, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn descarta_worktree_branch_e_config() {
        let (_tmp, root) = repo();
        let task = create(&root, "x", "g").unwrap();
        std::fs::write(task.path.join("pendente.txt"), "x").unwrap();

        discard(&root, "x").unwrap();
        assert!(!task.path.exists());
        assert!(list(&root).unwrap().is_empty());
        assert!(git::run(&root, &["config", "--get", "branch.task/x.description"]).is_err());
        // O nome fica livre para uma nova tarefa.
        create(&root, "x", "de novo").unwrap();
    }

    #[test]
    fn so_worktree_de_tarefa_libera_autonomia_total() {
        let (tmp, root) = repo();
        let task = create(&root, "x", "g").unwrap();
        std::fs::create_dir(task.path.join("sub")).unwrap();

        assert!(is_task_worktree(&task.path));
        assert!(is_task_worktree(&task.path.join("sub")));
        assert!(!is_task_worktree(&root));
        assert!(!is_task_worktree(tmp.path()));

        // Um branch task/* no worktree principal não conta.
        git_in(&root, &["checkout", "-q", "-b", "task/falso"]);
        assert!(!is_task_worktree(&root));
    }

    #[test]
    fn repositorio_sem_commits() {
        let tmp = tempfile::tempdir().unwrap();
        git_in(tmp.path(), &["init", "-q"]);
        assert!(matches!(
            create(tmp.path(), "x", "g"),
            Err(Error::NoCommits)
        ));
    }
}
