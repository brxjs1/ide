//! Quadro de tarefas: cada tarefa é um Markdown em `.project/tasks/<slug>.md` (o mesmo
//! lugar das especificações de tarefas autônomas do Brain), legível por você e pelo agente.
//!
//! ```text
//! # Validar CPF no cadastro
//!
//! - Status: em progresso        ← a fazer | em progresso | concluída
//! - Prioridade: alta            ← alta | média | baixa (opcional)
//! - Worktree: task/validar-cpf  ← opcional, preenchido ao entregar ao agente
//!
//! ## Objetivo
//! ...
//! - [x] critério feito          ← o checklist vira a barra de progresso
//! - [ ] critério pendente
//! ```
//!
//! Os metadados são as linhas `- Chave: valor` antes do primeiro `## `.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{files, tasks::validate_slug, Error, Result};

pub const DIR: &str = ".project/tasks";
/// Arquivos da pasta que não são tarefas.
const IGNORED: &[&str] = &["TEMPLATE.md", "README.md"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Todo,
    Doing,
    Done,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Todo => "a fazer",
            Self::Doing => "em progresso",
            Self::Done => "concluída",
        }
    }

    /// Aceita os rótulos em português e os nomes curtos em inglês.
    pub fn parse(text: &str) -> Option<Self> {
        let t = text.trim().to_lowercase();
        Some(match t.as_str() {
            "a fazer" | "todo" | "pendente" | "backlog" => Self::Todo,
            "em progresso" | "fazendo" | "doing" | "em andamento" | "in progress" => Self::Doing,
            "concluída" | "concluida" | "feita" | "feito" | "done" => Self::Done,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTask {
    pub slug: String,
    pub title: String,
    pub status: Status,
    /// alta, média ou baixa.
    pub priority: Option<String>,
    /// Branch do worktree que está executando a tarefa (`task/<slug>`).
    pub worktree: Option<String>,
    pub checklist_done: usize,
    pub checklist_total: usize,
    /// Primeiro parágrafo do objetivo (ou do corpo).
    pub summary: String,
    /// Caminho relativo à raiz, para abrir no editor.
    pub path: String,
    /// Última modificação (segundos desde a época).
    pub updated: u64,
}

pub fn list(root: &Path) -> Result<Vec<BoardTask>> {
    let dir = root.join(DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(slug) = name.strip_suffix(".md") else {
            continue;
        };
        if IGNORED.contains(&name.as_str()) || validate_slug(slug).is_err() {
            continue;
        }
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        // Um arquivo ruim (binário, grande demais, link para fora) não derruba o quadro.
        if let Ok(task) = load(root, slug) {
            out.push(task);
        }
    }
    out.sort_by(|a, b| {
        a.status
            .cmp(&b.status)
            .then(priority_rank(&a.priority).cmp(&priority_rank(&b.priority)))
            .then(b.updated.cmp(&a.updated))
            .then(a.slug.cmp(&b.slug))
    });
    Ok(out)
}

pub fn get(root: &Path, slug: &str) -> Result<BoardTask> {
    validate_slug(slug)?;
    load(root, slug)
}

/// Cria a tarefa com um esqueleto de objetivo e critérios. O slug vem do título.
pub fn create(
    root: &Path,
    title: &str,
    status: Status,
    priority: Option<&str>,
    description: Option<&str>,
) -> Result<BoardTask> {
    let title = one_line(title);
    let title = title.trim();
    let base = slugify(title);
    validate_slug(&base)?;
    // Reserva o nome com `create_new` (atômico): duas criações com o mesmo título
    // ganham slugs diferentes em vez de uma sobrescrever a outra.
    let mut slug = base.clone();
    let mut n = 2;
    loop {
        let path = files::resolve(root, &rel_path(&slug))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(files::resolve(root, &rel_path(&slug))?)
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 1000 => {}
            Err(e) => return Err(e.into()),
        }
        let suffix = format!("-{n}");
        let keep = base[..base.len().min(50 - suffix.len())].trim_end_matches('-');
        slug = format!("{keep}{suffix}");
        n += 1;
    }
    let mut text = format!("# {title}\n\n- Status: {}\n", status.label());
    if let Some(p) = priority.map(one_line).filter(|p| !p.trim().is_empty()) {
        text.push_str(&format!("- Prioridade: {}\n", p.trim()));
    }
    let objective = description
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or("<o que deve existir ao final>");
    text.push_str(&format!(
        "\n## Objetivo\n\n{objective}\n\n## Critérios de aceite\n\n- [ ] <comportamento verificável>\n"
    ));
    files::write(root, &rel_path(&slug), &text)?;
    load(root, &slug)
}

pub fn set_status(root: &Path, slug: &str, status: Status) -> Result<BoardTask> {
    set_meta(root, slug, "Status", Some(status.label()))
}

/// Define (ou remove, com `None`) um metadado `- Chave: valor`.
pub fn set_meta(root: &Path, slug: &str, key: &str, value: Option<&str>) -> Result<BoardTask> {
    validate_slug(slug)?;
    let text = read(root, slug)?;
    let value = value.map(one_line);
    files::write(
        root,
        &rel_path(slug),
        &with_meta(&text, key, value.as_deref()),
    )?;
    load(root, slug)
}

pub fn delete(root: &Path, slug: &str) -> Result<()> {
    validate_slug(slug)?;
    let path = files::resolve(root, &rel_path(slug))?;
    if !path.is_file() {
        return Err(Error::BoardTaskNotFound(slug.to_owned()));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Título e metadados ficam numa linha: uma quebra viraria outro metadado.
fn one_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

fn rel_path(slug: &str) -> String {
    format!("{DIR}/{slug}.md")
}

fn read(root: &Path, slug: &str) -> Result<String> {
    match files::read(root, &rel_path(slug)) {
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::BoardTaskNotFound(slug.to_owned()))
        }
        other => other,
    }
}

fn load(root: &Path, slug: &str) -> Result<BoardTask> {
    let text = read(root, slug)?;
    let path = files::resolve(root, &rel_path(slug))?;
    let updated = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Ok(parse(slug, &text, updated))
}

fn parse(slug: &str, text: &str, updated: u64) -> BoardTask {
    let title = text
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty() && !t.starts_with('<'))
        .unwrap_or_else(|| slug.replace('-', " "));
    let meta = |key: &str| meta_value(text, key);
    let checked = text
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("- [x]") || t.starts_with("- [X]")
        })
        .count();
    // `- [ ] <comportamento verificável>` é marcador do modelo, não critério de verdade.
    let open = text
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("- [ ]") && !t["- [ ]".len()..].trim_start().starts_with('<')
        })
        .count();
    BoardTask {
        slug: slug.to_owned(),
        title,
        status: meta("Status")
            .and_then(|s| Status::parse(&s))
            .unwrap_or(Status::Todo),
        priority: meta("Prioridade").filter(|p| !p.starts_with('<')),
        worktree: meta("Worktree").filter(|w| !w.starts_with('<') && !w.contains('`')),
        checklist_done: checked,
        checklist_total: checked + open,
        summary: summary(text),
        path: rel_path(slug),
        updated,
    }
}

/// Linhas de metadados: as `- Chave: valor` antes do primeiro `## `.
fn header_end(lines: &[&str]) -> usize {
    lines
        .iter()
        .position(|l| l.starts_with("## "))
        .unwrap_or(lines.len())
}

fn meta_value(text: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    lines[..header_end(&lines)]
        .iter()
        .find_map(|l| meta_of(l, key))
        .map(str::to_owned)
}

fn meta_of<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.trim_start().strip_prefix("- ")?;
    let (k, v) = rest.split_once(':')?;
    k.trim().eq_ignore_ascii_case(key).then(|| v.trim())
}

fn with_meta(text: &str, key: &str, value: Option<&str>) -> String {
    // Mantém o fim de linha do arquivo (CRLF no Windows).
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.lines().collect();
    let end = header_end(&lines);
    let line = value.map(|v| format!("- {key}: {v}"));
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    if let Some(i) = lines[..end].iter().position(|l| meta_of(l, key).is_some()) {
        match line {
            Some(l) => out[i] = l,
            None => {
                out.remove(i);
            }
        }
    } else if let Some(l) = line {
        // Depois do último metadado; sem nenhum, logo abaixo do título.
        let last_meta = lines[..end]
            .iter()
            .rposition(|l| l.trim_start().starts_with("- ") && l.contains(':'));
        // O título só vale no cabeçalho (um `# ` depois pode ser comentário num bloco de código).
        match (
            last_meta,
            lines[..end].iter().position(|l| l.starts_with("# ")),
        ) {
            (Some(i), _) => out.insert(i + 1, l),
            (None, Some(t)) => {
                out.insert(t + 1, String::new());
                out.insert(t + 2, l);
            }
            (None, None) => {
                out.insert(0, l);
                out.insert(1, String::new());
            }
        }
    }
    let mut joined = out.join(newline);
    if text.ends_with('\n') || text.is_empty() {
        joined.push_str(newline);
    }
    joined
}

fn summary(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("## objetivo"))
        .map(|i| i + 1)
        .unwrap_or_else(|| header_end(&lines));
    let paragraph: Vec<&str> = lines[start.min(lines.len())..]
        .iter()
        .map(|l| l.trim())
        .skip_while(|l| l.is_empty() || l.starts_with('#'))
        .take_while(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let text = paragraph.join(" ");
    if text.starts_with('<') {
        String::new()
    } else {
        text.chars().take(240).collect()
    }
}

fn priority_rank(priority: &Option<String>) -> u8 {
    match priority.as_deref().map(str::to_lowercase).as_deref() {
        Some("alta") | Some("high") => 0,
        Some("média") | Some("media") | Some("medium") => 1,
        Some("baixa") | Some("low") => 2,
        _ => 3,
    }
}

/// "Validar CPF no cadastro!" → "validar-cpf-no-cadastro" (até 50 caracteres).
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for ch in title.to_lowercase().chars() {
        let mapped = match ch {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        };
        if mapped == '-' && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push(mapped);
    }
    let mut slug: String = out.trim_end_matches('-').chars().take(50).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "tarefa".to_owned()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_a_partir_do_titulo() {
        assert_eq!(
            slugify("Validar CPF no cadastro!"),
            "validar-cpf-no-cadastro"
        );
        assert_eq!(slugify("  Ação: revisão — já  "), "acao-revisao-ja");
        assert_eq!(slugify("???"), "tarefa");
        assert!(slugify(&"x".repeat(80)).len() <= 50);
    }

    #[test]
    fn criar_listar_mover_e_apagar() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(list(root).unwrap().is_empty(), "sem pasta, quadro vazio");

        let a = create(
            root,
            "Validar CPF",
            Status::Todo,
            Some("alta"),
            Some("Recusar CPFs inválidos no cadastro."),
        )
        .unwrap();
        assert_eq!(a.slug, "validar-cpf");
        assert_eq!(a.summary, "Recusar CPFs inválidos no cadastro.");
        assert_eq!(
            (a.checklist_done, a.checklist_total),
            (0, 0),
            "critério de modelo não conta"
        );
        let b = create(root, "Validar CPF", Status::Doing, None, None).unwrap();
        assert_eq!(b.slug, "validar-cpf-2", "slug livre");
        assert_eq!(b.summary, "", "placeholder do modelo não vira resumo");

        // O TEMPLATE do Brain fica de fora, e um arquivo ruim não quebra o quadro.
        std::fs::write(root.join(DIR).join("TEMPLATE.md"), "# <slug>\n").unwrap();
        std::fs::write(root.join(DIR).join("binario.md"), [0u8, 159, 146, 150]).unwrap();
        let all = list(root).unwrap();
        assert_eq!(
            all.iter()
                .map(|t| (t.slug.as_str(), t.status))
                .collect::<Vec<_>>(),
            [
                ("validar-cpf", Status::Todo),
                ("validar-cpf-2", Status::Doing)
            ]
        );

        let moved = set_status(root, "validar-cpf", Status::Done).unwrap();
        assert_eq!(moved.status, Status::Done);
        let text = std::fs::read_to_string(root.join(DIR).join("validar-cpf.md")).unwrap();
        assert!(
            text.contains("- Status: concluída\n- Prioridade: alta\n"),
            "{text}"
        );

        let linked = set_meta(
            root,
            "validar-cpf-2",
            "Worktree",
            Some("task/validar-cpf-2"),
        )
        .unwrap();
        assert_eq!(linked.worktree.as_deref(), Some("task/validar-cpf-2"));
        let injected = set_meta(
            root,
            "validar-cpf-2",
            "Prioridade",
            Some("alta\n- Status: concluída"),
        )
        .unwrap();
        assert_eq!(
            injected.status,
            Status::Doing,
            "quebra de linha não injeta metadado"
        );
        let unlinked = set_meta(root, "validar-cpf-2", "Worktree", None).unwrap();
        assert_eq!(unlinked.worktree, None);

        delete(root, "validar-cpf-2").unwrap();
        assert!(matches!(
            delete(root, "validar-cpf-2"),
            Err(Error::BoardTaskNotFound(_))
        ));
        assert!(matches!(
            set_status(root, "nao-existe", Status::Done),
            Err(Error::BoardTaskNotFound(_))
        ));
        assert!(matches!(
            set_status(root, "../fora", Status::Done),
            Err(Error::InvalidSlug(_))
        ));
    }

    #[test]
    fn le_tarefas_escritas_a_mao_e_o_modelo_do_brain() {
        let text = "# Migrar o banco\n\n- Autonomia: autonomous\n- status: Fazendo\n- Worktree: `task/<slug>` (criado com x)\n\n## Objetivo\n\nTrocar SQLite por Postgres\nsem downtime.\n\n## Critérios de aceite\n\n- [x] backup\n- [X] script\n- [ ] testes\n\n- Status: concluída\n";
        let t = parse("migrar-o-banco", text, 7);
        assert_eq!(t.title, "Migrar o banco");
        assert_eq!(
            t.status,
            Status::Doing,
            "metadado só no cabeçalho, sem diferenciar maiúsculas"
        );
        assert_eq!(t.worktree, None, "placeholder do modelo");
        assert_eq!((t.checklist_done, t.checklist_total), (2, 3));
        assert_eq!(t.summary, "Trocar SQLite por Postgres sem downtime.");

        // Sem nenhum metadado, o status entra logo abaixo do título.
        let bare = with_meta("# Só título\n\nTexto.\n", "Status", Some("em progresso"));
        assert_eq!(bare, "# Só título\n\n- Status: em progresso\n\nTexto.\n");
    }

    #[test]
    fn metadado_mantem_crlf_e_ignora_titulo_em_bloco_de_codigo() {
        let crlf = with_meta(
            "# T\r\n\r\n- Status: a fazer\r\n\r\n## Notas\r\n",
            "Status",
            Some("concluída"),
        );
        assert_eq!(crlf, "# T\r\n\r\n- Status: concluída\r\n\r\n## Notas\r\n");
        // Sem título nem metadado: um `# comentário` num bloco depois do `##` não é o título.
        let text = "## Comandos\n\n```bash\n# rodar testes\n```\n";
        let out = with_meta(text, "Status", Some("a fazer"));
        assert_eq!(out, format!("- Status: a fazer\n\n{text}"));
        assert_eq!(
            with_meta(&out, "Status", Some("concluída"))
                .matches("- Status")
                .count(),
            1
        );
    }

    #[test]
    fn slug_longo_repetido_nao_gera_hifen_duplo() {
        let dir = tempfile::tempdir().unwrap();
        // 49 letras + "-" na posição 50 do slug cortado.
        let title = format!("{} b", "a".repeat(47));
        let first = create(dir.path(), &title, Status::Todo, None, None).unwrap();
        let second = create(dir.path(), &title, Status::Todo, None, None).unwrap();
        assert_ne!(first.slug, second.slug);
        assert!(!second.slug.contains("--"), "{}", second.slug);
    }
}
