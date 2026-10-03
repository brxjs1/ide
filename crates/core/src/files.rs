//! Arquivos do projeto para o editor. Todo caminho vem da UI, então nada sai da raiz:
//! caminhos absolutos e `..` são recusados, e symlinks são resolvidos antes da checagem.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::{Error, Result};

/// Arquivos maiores que isso não abrem no editor.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Limite da árvore para repositórios enormes.
pub const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Relativo à raiz, com `/`.
    pub path: String,
    pub dir: bool,
}

/// Árvore do projeto respeitando .gitignore (inclui arquivos ocultos, exceto `.git`).
/// Diretórios antes de arquivos, em ordem alfabética dentro de cada pasta.
pub fn tree(root: &Path) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_path(|a, b| {
            let rank = |p: &Path| if p.is_dir() { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
        })
        .build();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        entries.push(Entry {
            path: to_slash(rel),
            dir: entry.file_type().is_some_and(|t| t.is_dir()),
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    Ok(entries)
}

/// Caminho absoluto de `rel` dentro de `root`, recusando o que escapa da raiz.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let outside = || Error::OutsideRoot(rel.to_owned());
    let rel_path = Path::new(rel);
    if rel.is_empty()
        || rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(outside());
    }
    let root = root.canonicalize()?;
    let joined = root.join(rel_path);
    // O arquivo pode não existir (gravação nova): valida a pasta mais próxima que existe.
    let mut existing = joined.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or_else(outside)?;
    }
    if !existing.canonicalize()?.starts_with(&root) {
        return Err(outside());
    }
    Ok(joined)
}

pub fn read(root: &Path, rel: &str) -> Result<String> {
    let path = resolve(root, rel)?;
    let size = std::fs::metadata(&path)?.len();
    if size > MAX_FILE_BYTES {
        return Err(Error::TooLarge(size));
    }
    let bytes = std::fs::read(&path)?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(Error::Binary(rel.to_owned()));
    }
    String::from_utf8(bytes).map_err(|_| Error::Binary(rel.to_owned()))
}

/// Grava de forma atômica (arquivo temporário + rename), criando pastas se preciso.
pub fn write(root: &Path, rel: &str, content: &str) -> Result<()> {
    let path = resolve(root, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Revalida depois de criar as pastas (nenhum symlink novo pode ter entrado no caminho).
    resolve(root, rel)?;
    // Symlink dentro do projeto (ex.: CLAUDE.md -> AGENTS.md): grava no alvo, sem trocar
    // o link por um arquivo comum. `resolve` já garantiu que o alvo fica dentro da raiz.
    let path = match std::fs::canonicalize(&path) {
        Ok(target) if target.starts_with(std::fs::canonicalize(root)?) => target,
        Ok(_) => return Err(Error::OutsideRoot(rel.to_owned())),
        Err(_) => path, // arquivo novo
    };
    let (tmp, mut file) = create_temp(&path)?;
    let written = (|| {
        use std::io::Write;
        file.write_all(content.as_bytes())?;
        // Mantém as permissões do original (um .env com 0600 não pode virar 0644).
        if let Ok(meta) = std::fs::metadata(&path) {
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(written?)
}

/// Arquivo temporário novo ao lado do destino. `create_new` (O_EXCL) falha se já existir
/// qualquer coisa com o nome, inclusive um symlink plantado: nunca escreve através de um.
fn create_temp(path: &Path) -> Result<(PathBuf, std::fs::File)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    for _ in 0..16 {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_file_name(format!(
            ".{name}.{}-{nanos:x}-{n}.ide-tmp",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "sem nome livre para o temporário",
    )
    .into())
}

fn to_slash(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn a() {}\n").unwrap();
        std::fs::write(root.join("src/deep/x.rs"), "").unwrap();
        std::fs::write(root.join("target/lixo"), "").unwrap();
        std::fs::write(root.join(".git/HEAD"), "").unwrap();
        dir
    }

    #[test]
    fn arvore_respeita_gitignore_e_ordena_pastas_primeiro() {
        let dir = project();
        let paths: Vec<_> = tree(dir.path())
            .unwrap()
            .into_iter()
            .map(|e| format!("{}{}", e.path, if e.dir { "/" } else { "" }))
            .collect();
        assert_eq!(
            paths,
            [
                "src/",
                "src/deep/",
                "src/deep/x.rs",
                "src/lib.rs",
                ".gitignore",
                "Cargo.toml"
            ]
        );
    }

    #[test]
    fn le_e_grava_dentro_da_raiz() {
        let dir = project();
        assert_eq!(read(dir.path(), "src/lib.rs").unwrap(), "pub fn a() {}\n");
        write(dir.path(), "src/novo/mod.rs", "// oi\n").unwrap();
        assert_eq!(read(dir.path(), "./src/novo/mod.rs").unwrap(), "// oi\n");
        assert!(!dir.path().join("src/novo/.mod.rs.ide-tmp").exists());
    }

    #[test]
    fn recusa_caminhos_que_escapam() {
        let dir = project();
        for bad in ["", "../fora.txt", "src/../../fora", "/etc/passwd"] {
            assert!(
                matches!(read(dir.path(), bad), Err(Error::OutsideRoot(_))),
                "leu {bad:?}"
            );
            assert!(
                matches!(write(dir.path(), bad, "x"), Err(Error::OutsideRoot(_))),
                "gravou {bad:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn escrita_em_symlink_interno_grava_no_alvo() {
        let dir = project();
        std::os::unix::fs::symlink("lib.rs", dir.path().join("src/atalho.rs")).unwrap();
        write(dir.path(), "src/atalho.rs", "pelo link").unwrap();
        let link = dir.path().join("src/atalho.rs");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src/lib.rs")).unwrap(),
            "pelo link"
        );
    }

    #[test]
    fn escrita_nao_segue_symlink_no_temporario_e_mantem_permissoes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = project();
        let outside = tempfile::tempdir().unwrap();
        let alvo = outside.path().join("bashrc");
        std::fs::write(&alvo, "original").unwrap();
        // Nome de temporário previsível (versão antiga) apontando para fora da raiz.
        std::os::unix::fs::symlink(&alvo, dir.path().join("src/.lib.rs.ide-tmp")).unwrap();
        let lib = dir.path().join("src/lib.rs");
        std::fs::set_permissions(&lib, std::fs::Permissions::from_mode(0o600)).unwrap();

        write(dir.path(), "src/lib.rs", "novo").unwrap();

        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "original");
        let meta = std::fs::symlink_metadata(&lib).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&lib).unwrap(), "novo");
        let sobras: Vec<_> = std::fs::read_dir(dir.path().join("src"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".ide-tmp"))
            .filter(|e| !e.file_type().unwrap().is_symlink())
            .collect();
        assert!(sobras.is_empty());
    }

    #[test]
    fn recusa_symlink_para_fora() {
        let dir = project();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("segredo"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("atalho")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("segredo"),
            dir.path().join("link-arquivo"),
        )
        .unwrap();

        assert!(matches!(
            read(dir.path(), "atalho/segredo"),
            Err(Error::OutsideRoot(_))
        ));
        assert!(matches!(
            read(dir.path(), "link-arquivo"),
            Err(Error::OutsideRoot(_))
        ));
        assert!(matches!(
            write(dir.path(), "atalho/novo", "x"),
            Err(Error::OutsideRoot(_))
        ));
        assert!(!outside.path().join("novo").exists());
    }

    #[test]
    fn recusa_binario_e_grande() {
        let dir = project();
        std::fs::write(dir.path().join("img.bin"), [0u8, 1, 2]).unwrap();
        assert!(matches!(read(dir.path(), "img.bin"), Err(Error::Binary(_))));
        let big = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        std::fs::write(dir.path().join("grande.txt"), big).unwrap();
        assert!(matches!(
            read(dir.path(), "grande.txt"),
            Err(Error::TooLarge(_))
        ));
    }
}
