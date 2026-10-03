//! Análise sintática com tree-sitter: outline de arquivos e busca de símbolos no projeto.
//! Usado pelo editor (painel de outline) e pelo agente (ferramentas MCP em `ide-mcp`).

use std::path::Path;

use serde::Serialize;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

/// Arquivos maiores que isso são ignorados na busca (geralmente gerados).
const MAX_SEARCH_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
}

impl Lang {
    pub fn from_path(path: &Path) -> Option<Self> {
        Some(match path.extension()?.to_str()? {
            "rs" => Self::Rust,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "js" | "mjs" | "cjs" | "jsx" => Self::JavaScript,
            "py" | "pyi" => Self::Python,
            "go" => Self::Go,
            _ => return None,
        })
    }

    fn language(self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }

    /// Query de definições: `@name` é o identificador; o outro capture é o tipo do símbolo.
    fn query(self) -> String {
        match self {
            Self::Rust => RUST_QUERY.to_owned(),
            Self::TypeScript | Self::Tsx => format!("{JS_COMMON}{TS_EXTRA}"),
            Self::JavaScript => format!("{JS_COMMON}{JS_EXTRA}"),
            Self::Python => PY_QUERY.to_owned(),
            Self::Go => GO_QUERY.to_owned(),
        }
    }
}

const RUST_QUERY: &str = r#"
(function_item name: (identifier) @name) @function
(function_signature_item name: (identifier) @name) @function
(struct_item name: (type_identifier) @name) @struct
(enum_item name: (type_identifier) @name) @enum
(union_item name: (type_identifier) @name) @struct
(trait_item name: (type_identifier) @name) @trait
(impl_item type: (_) @name) @impl
(mod_item name: (identifier) @name) @module
(const_item name: (identifier) @name) @constant
(static_item name: (identifier) @name) @constant
(type_item name: (type_identifier) @name) @type
(macro_definition name: (identifier) @name) @macro
"#;

/// Comum a JavaScript e TypeScript.
const JS_COMMON: &str = r#"
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(method_definition name: (property_identifier) @name) @method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
"#;

const TS_EXTRA: &str = r#"
(class_declaration name: (type_identifier) @name) @class
(abstract_class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @interface
(type_alias_declaration name: (type_identifier) @name) @type
(enum_declaration name: (identifier) @name) @enum
"#;

const JS_EXTRA: &str = r#"
(class_declaration name: (identifier) @name) @class
"#;

const PY_QUERY: &str = r#"
(function_definition name: (identifier) @name) @function
(class_definition name: (identifier) @name) @class
"#;

const GO_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @function
(method_declaration name: (field_identifier) @name) @method
(type_spec name: (type_identifier) @name) @type
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    /// function, method, struct, class, enum, trait, interface, impl, module, type, constant, macro.
    pub kind: String,
    /// 1-based.
    pub line: u32,
    pub end_line: u32,
    /// Símbolo que contém este (ex.: o impl ou a classe de um método).
    pub container: Option<String>,
    /// Profundidade de aninhamento (0 = topo do arquivo).
    pub depth: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("linguagem não suportada: {0}")]
    Unsupported(String),
    #[error("arquivo grande demais ({0} bytes)")]
    TooLarge(u64),
    #[error("tree-sitter: {0}")]
    TreeSitter(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Símbolos definidos em `source`, na ordem em que aparecem.
pub fn outline(source: &str, lang: Lang) -> Result<Vec<Symbol>> {
    let language = lang.language();
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|e| Error::TreeSitter(e.to_string()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| Error::TreeSitter("parse cancelado".into()))?;

    let query =
        Query::new(&language, &lang.query()).map_err(|e| Error::TreeSitter(e.to_string()))?;
    let name_idx = query
        .capture_index_for_name("name")
        .ok_or_else(|| Error::TreeSitter("query sem @name".into()))?;

    // (nó da definição, nome, tipo)
    let mut found: Vec<(Node, String, String)> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    while let Some(m) = matches.next() {
        let mut name = None;
        let mut def = None;
        for cap in m.captures() {
            if cap.index == name_idx {
                name = cap
                    .node
                    .utf8_text(source.as_bytes())
                    .ok()
                    .map(str::to_owned);
            } else {
                def = Some((
                    cap.node,
                    query.capture_names()[cap.index as usize].to_owned(),
                ));
            }
        }
        if let (Some(name), Some((node, kind))) = (name, def) {
            if !found.iter().any(|(n, _, _)| n.id() == node.id()) {
                found.push((node, name, kind));
            }
        }
    }
    found.sort_by_key(|(n, _, _)| (n.start_byte(), std::cmp::Reverse(n.end_byte())));

    // Container = símbolo anterior mais próximo que envolve este.
    let mut symbols = Vec::with_capacity(found.len());
    let mut stack: Vec<(usize, usize, String, String)> = Vec::new(); // (início, fim, nome, tipo)
    for (node, name, kind) in found {
        while stack
            .last()
            .is_some_and(|(_, end, _, _)| *end <= node.start_byte())
        {
            stack.pop();
        }
        let parent = stack.last().cloned();
        // Função dentro de impl/trait/classe é método.
        let kind = match (&parent, kind.as_str()) {
            (Some((_, _, _, pk)), "function")
                if matches!(pk.as_str(), "impl" | "trait" | "class") =>
            {
                "method".to_owned()
            }
            _ => kind,
        };
        let name = if kind == "impl" { compact(&name) } else { name };
        symbols.push(Symbol {
            line: node.start_position().row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            container: parent.as_ref().map(|(_, _, n, _)| n.clone()),
            depth: stack.len() as u32,
            name: name.clone(),
            kind: kind.clone(),
        });
        stack.push((node.start_byte(), node.end_byte(), name, kind));
    }
    Ok(symbols)
}

pub fn outline_file(path: &Path) -> Result<Vec<Symbol>> {
    let lang =
        Lang::from_path(path).ok_or_else(|| Error::Unsupported(path.display().to_string()))?;
    let size = std::fs::metadata(path)?.len();
    if size > MAX_SEARCH_BYTES {
        return Err(Error::TooLarge(size));
    }
    outline(&std::fs::read_to_string(path)?, lang)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    /// Relativo à raiz, com `/`.
    pub path: String,
    pub symbol: Symbol,
}

/// Procura definições pelo nome em todo o projeto (respeitando .gitignore).
/// Nome exato primeiro; depois quem começa com `query` (sem diferenciar maiúsculas).
pub fn find_symbol(root: &Path, query: &str, limit: usize) -> Result<Vec<SymbolMatch>> {
    let needle = query.to_lowercase();
    let mut exact = Vec::new();
    let mut prefix = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .flatten()
    {
        let path = entry.path();
        let Some(lang) = Lang::from_path(path) else {
            continue;
        };
        // Symlinks ficam de fora: podem apontar para fora da raiz (ou para /dev/zero).
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_SEARCH_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(symbols) = outline(&source, lang) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        for symbol in symbols {
            let lower = symbol.name.to_lowercase();
            let m = SymbolMatch {
                path: rel.clone(),
                symbol,
            };
            if m.symbol.name == query {
                exact.push(m);
            } else if lower.starts_with(&needle) {
                prefix.push(m);
            }
        }
        if exact.len() >= limit {
            break;
        }
    }
    exact.extend(prefix);
    exact.truncate(limit);
    Ok(exact)
}

/// `impl Foo for Bar` vira só o tipo, sem espaços extras.
fn compact(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(symbols: &[Symbol]) -> Vec<String> {
        symbols
            .iter()
            .map(|s| {
                format!(
                    "{}{} {}{}",
                    "  ".repeat(s.depth as usize),
                    s.kind,
                    s.name,
                    s.container
                        .as_ref()
                        .map(|c| format!(" <{c}>"))
                        .unwrap_or_default()
                )
            })
            .collect()
    }

    #[test]
    fn outline_rust() {
        let src = r#"
mod util;
pub struct Conta { saldo: i64 }
pub enum Erro { Saldo }
pub trait Banco { fn sacar(&mut self, v: i64); }
impl Conta {
    pub fn nova() -> Self { Self { saldo: 0 } }
    fn depositar(&mut self, v: i64) { self.saldo += v; }
}
const LIMITE: i64 = 10;
macro_rules! log { () => {}; }
fn main() {}
"#;
        let symbols = outline(src, Lang::Rust).unwrap();
        assert_eq!(
            names(&symbols),
            [
                "module util",
                "struct Conta",
                "enum Erro",
                "trait Banco",
                "  method sacar <Banco>",
                "impl Conta",
                "  method nova <Conta>",
                "  method depositar <Conta>",
                "constant LIMITE",
                "macro log",
                "function main",
            ]
        );
        assert_eq!(symbols[1].line, 3);
        assert_eq!(symbols[5].end_line, 9);
    }

    #[test]
    fn outline_typescript_e_tsx() {
        let src = r#"
export interface Props { a: number }
export type Id = string;
export enum Cor { Azul }
export class Loja {
  comprar(id: Id) { return id; }
}
export const soma = (a: number, b: number) => a + b;
export function App(props: Props) { return null; }
"#;
        let expected = [
            "interface Props",
            "type Id",
            "enum Cor",
            "class Loja",
            "  method comprar <Loja>",
            "function soma",
            "function App",
        ];
        assert_eq!(names(&outline(src, Lang::TypeScript).unwrap()), expected);
        assert_eq!(names(&outline(src, Lang::Tsx).unwrap()), expected);
    }

    #[test]
    fn outline_javascript_python_go() {
        let js = "class A { m() {} }\nfunction f() {}\nconst g = function () {};\n";
        assert_eq!(
            names(&outline(js, Lang::JavaScript).unwrap()),
            ["class A", "  method m <A>", "function f", "function g"]
        );

        let py = "class Pessoa:\n    def falar(self):\n        pass\n\ndef main():\n    pass\n";
        assert_eq!(
            names(&outline(py, Lang::Python).unwrap()),
            ["class Pessoa", "  method falar <Pessoa>", "function main"]
        );

        let go = "package x\ntype Conta struct{}\nfunc (c *Conta) Sacar() {}\nfunc main() {}\n";
        assert_eq!(
            names(&outline(go, Lang::Go).unwrap()),
            ["type Conta", "method Sacar", "function main"]
        );
    }

    #[test]
    fn linguagem_pelo_caminho() {
        assert_eq!(Lang::from_path(Path::new("a/b.rs")), Some(Lang::Rust));
        assert_eq!(Lang::from_path(Path::new("App.tsx")), Some(Lang::Tsx));
        assert_eq!(Lang::from_path(Path::new("x.mjs")), Some(Lang::JavaScript));
        assert_eq!(Lang::from_path(Path::new("README.md")), None);
    }

    #[test]
    fn busca_simbolo_no_projeto() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("ignorado")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignorado/\n").unwrap();
        std::fs::write(
            root.join("src/conta.rs"),
            "pub struct Conta;\nfn contar() {}\n",
        )
        .unwrap();
        std::fs::write(root.join("src/app.ts"), "export class ContaView {}\n").unwrap();
        std::fs::write(root.join("ignorado/x.rs"), "struct Conta;\n").unwrap();
        // Symlink para fora da raiz: não pode vazar símbolos de lá.
        let fora = tempfile::tempdir().unwrap();
        std::fs::write(fora.path().join("y.rs"), "struct ContaDeFora;\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(fora.path().join("y.rs"), root.join("src/link.rs")).unwrap();

        let found = find_symbol(root, "Conta", 10).unwrap();
        let summary: Vec<_> = found
            .iter()
            .map(|m| format!("{}:{} {}", m.path, m.symbol.line, m.symbol.name))
            .collect();
        assert_eq!(
            summary[0], "src/conta.rs:1 Conta",
            "exato primeiro: {summary:?}"
        );
        assert_eq!(summary.len(), 3, "{summary:?}");
        assert!(summary.contains(&"src/app.ts:1 ContaView".to_owned()));
        assert!(summary.contains(&"src/conta.rs:2 contar".to_owned()));
        assert_eq!(find_symbol(root, "conta", 1).unwrap().len(), 1);
    }
}
