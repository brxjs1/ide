//! Análise de qualidade de código no estilo do SonarLint, local e sem rede: regras sobre a
//! árvore do tree-sitter (`ide-syntax`) para JavaScript/TypeScript, mais TODO/FIXME em
//! qualquer linguagem. Cada problema traz tipo, severidade, a regra (com "por que" e "como
//! corrigir") e, quando dá, uma correção automática. O projeto inteiro recebe notas A–E.
//!
//! Supressão: `// NOSONAR` na linha, ou `// ide-lint-disable-next-line [S1234 ...]` na
//! linha anterior.

mod checks;
mod rules;

use std::path::Path;

pub use ide_syntax::Lang;
pub use rules::{rule, rules, Kind, Rule, Scope, Severity};
use serde::Serialize;

/// Arquivos maiores que isso ficam fora da análise do projeto (geralmente gerados).
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Linhas mais longas que isso indicam código minificado: o arquivo é pulado.
const MINIFIED_LINE: usize = 1000;
/// Árvores mais fundas que isso não são analisadas: as verificações descem por recursão,
/// e um arquivo com milhares de níveis aninhados (gerado ou malicioso) estouraria a pilha
/// — o que derruba o processo inteiro, sem como capturar.
const MAX_TREE_DEPTH: usize = 400;

/// Trecho do código: linhas e colunas a partir de 1, colunas em unidades UTF-16 (as do
/// Monaco e do LSP), fim exclusivo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    #[serde(flatten)]
    pub span: Span,
    pub text: String,
}

/// Correção automática (quick fix).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub title: String,
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// Chave da regra (ex.: `S3776`); detalhes em [`rule`].
    pub rule: &'static str,
    pub message: String,
    pub kind: Kind,
    pub severity: Severity,
    #[serde(flatten)]
    pub span: Span,
    pub fix: Option<Fix>,
    /// Dá para ignorar com um comentário na linha anterior (a linha não começa dentro
    /// de uma string, template ou JSX).
    pub suppressible: bool,
}

/// Problemas em `source`, ordenados por posição.
pub fn lint_source(source: &str, lang: Lang) -> Vec<Issue> {
    let Ok(tree) = ide_syntax::parse(source, lang) else {
        return Vec::new();
    };
    if tree_depth(&tree) > MAX_TREE_DEPTH {
        return Vec::new();
    }
    let mut issues = checks::run(source, lang, &tree);
    let lines: Vec<&str> = source.lines().collect();
    issues.retain(|issue| !suppressed(issue, &lines));
    issues.sort_by_key(|i| (i.span.line, i.span.column, i.rule));
    issues
}

/// Profundidade máxima da árvore, sem recursão (cursor do tree-sitter).
fn tree_depth(tree: &ide_syntax::tree_sitter::Tree) -> usize {
    let mut cursor = tree.walk();
    let (mut depth, mut max) = (0usize, 0usize);
    loop {
        if cursor.goto_first_child() {
            depth += 1;
            max = max.max(depth);
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return max;
            }
            depth -= 1;
        }
    }
}

/// Problemas de um arquivo pelo caminho (linguagem pela extensão), com os mesmos limites
/// da análise do projeto: arquivos grandes ou minificados ficam de fora.
pub fn lint_path(path: &Path) -> std::io::Result<Vec<Issue>> {
    let Some(lang) = Lang::from_path(path) else {
        return Ok(Vec::new());
    };
    if std::fs::metadata(path)?.len() > MAX_FILE_BYTES {
        return Ok(Vec::new());
    }
    let source = std::fs::read_to_string(path)?;
    if source.lines().any(|l| l.len() > MINIFIED_LINE) {
        return Ok(Vec::new());
    }
    Ok(lint_source(&source, lang))
}

fn suppressed(issue: &Issue, lines: &[&str]) -> bool {
    let line = issue.span.line as usize;
    if lines.get(line - 1).is_some_and(|l| l.contains("NOSONAR")) {
        return true;
    }
    let Some(previous) = line.checked_sub(2).and_then(|i| lines.get(i)) else {
        return false;
    };
    let Some((_, rest)) = previous.split_once("ide-lint-disable-next-line") else {
        return false;
    };
    let keys: Vec<&str> = rest
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|k| k.starts_with('S'))
        .collect();
    keys.is_empty() || keys.contains(&issue.rule)
}

/// Notas no estilo do SonarQube.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ratings {
    /// Pela razão de dívida: tempo para corrigir os code smells / tempo para escrever o
    /// código (30 min por linha). A ≤ 5%, B ≤ 10%, C ≤ 20%, D ≤ 50%, E acima.
    pub maintainability: char,
    /// Pelo bug mais grave: A sem bugs (ou só Info), B menor, C maior, D crítico, E bloqueante.
    pub reliability: char,
    /// Pela vulnerabilidade mais grave, na mesma escala.
    pub security: char,
    /// Dívida técnica total, em minutos.
    pub debt_minutes: u32,
}

pub fn ratings(issues: &[Issue], lines: usize) -> Ratings {
    let debt: u32 = issues.iter().map(debt_of).sum();
    let ratio = debt as f64 / (lines.max(1) as f64 * 30.0);
    let maintainability = match ratio {
        r if r <= 0.05 => 'A',
        r if r <= 0.10 => 'B',
        r if r <= 0.20 => 'C',
        r if r <= 0.50 => 'D',
        _ => 'E',
    };
    let worst = |kind: Kind| match issues
        .iter()
        .filter(|i| i.kind == kind)
        .map(|i| i.severity)
        .max()
    {
        // Como no SonarQube, Info não conta para a nota.
        None | Some(Severity::Info) => 'A',
        Some(Severity::Minor) => 'B',
        Some(Severity::Major) => 'C',
        Some(Severity::Critical) => 'D',
        Some(Severity::Blocker) => 'E',
    };
    Ratings {
        maintainability,
        reliability: worst(Kind::Bug),
        security: worst(Kind::Vulnerability),
        debt_minutes: debt,
    }
}

fn debt_of(issue: &Issue) -> u32 {
    rule(issue.rule).map_or(0, |r| r.debt_minutes)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReport {
    /// Relativo à raiz, com `/`.
    pub path: String,
    pub lines: usize,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReport {
    /// Só arquivos com problemas, os piores primeiro.
    pub files: Vec<FileReport>,
    pub files_analyzed: usize,
    pub lines: usize,
    pub ratings: Ratings,
    /// O limite de arquivos foi atingido.
    pub truncated: bool,
}

/// Analisa o projeto respeitando `.gitignore` (também fora de repositórios git).
pub fn lint_project(root: &Path, max_files: usize) -> ProjectReport {
    let mut files = Vec::new();
    let mut analyzed = 0;
    let mut total_lines = 0;
    let mut truncated = false;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules")
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        // Symlinks ficam de fora: podem apontar para fora da raiz.
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(lang) = Lang::from_path(path) else {
            continue;
        };
        if entry.metadata().map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        if source.lines().any(|l| l.len() > MINIFIED_LINE) {
            continue;
        }
        if analyzed == max_files {
            truncated = true;
            break;
        }
        analyzed += 1;
        let lines = source.lines().count();
        total_lines += lines;
        let issues = lint_source(&source, lang);
        if issues.is_empty() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        files.push(FileReport {
            path: rel,
            lines,
            issues,
        });
    }
    let all: Vec<Issue> = files.iter().flat_map(|f| f.issues.clone()).collect();
    let ratings = ratings(&all, total_lines);
    files.sort_by(|a, b| {
        let worst = |f: &FileReport| f.issues.iter().map(|i| i.severity).max();
        worst(b)
            .cmp(&worst(a))
            .then(b.issues.len().cmp(&a.issues.len()))
            .then(a.path.cmp(&b.path))
    });
    ProjectReport {
        files,
        files_analyzed: analyzed,
        lines: total_lines,
        ratings,
        truncated,
    }
}

/// Aplica as edições de uma correção ao texto (para testes e para o agente).
pub fn apply_fix(source: &str, fix: &Fix) -> String {
    let mut edits: Vec<(usize, usize, &str)> = fix
        .edits
        .iter()
        .filter_map(|e| {
            let start = offset_of(source, e.span.line, e.span.column)?;
            let end = offset_of(source, e.span.end_line, e.span.end_column)?;
            Some((start, end, e.text.as_str()))
        })
        .collect();
    edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    let mut out = source.to_owned();
    for (start, end, text) in edits {
        out.replace_range(start..end, text);
    }
    out
}

/// Byte de (linha, coluna UTF-16), ambos a partir de 1.
fn offset_of(source: &str, line: u32, column: u32) -> Option<usize> {
    let mut start = 0;
    for _ in 1..line {
        start += source[start..].find('\n')? + 1;
    }
    let mut units = 0;
    for (i, ch) in source[start..].char_indices() {
        if units >= column - 1 || ch == '\n' {
            return Some(start + i);
        }
        units += ch.len_utf16() as u32;
    }
    Some(source.len())
}

#[cfg(test)]
mod tests;
