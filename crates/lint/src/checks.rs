//! As verificações em si: um passeio pela árvore do tree-sitter.

use ide_syntax::tree_sitter::{Node, Tree};
use ide_syntax::Lang;

use crate::rules::{rule, Scope};
use crate::{Edit, Fix, Issue, Span};

const MAX_COGNITIVE: u32 = 15;
const MAX_PARAMS: usize = 7;
const MAX_NESTING: u32 = 4;
const MAX_LOGICAL_OPS: usize = 3;
const MAX_FUNCTION_LINES: usize = 200;

const FUNCTIONS: &[&str] = &[
    "function_declaration",
    "function_expression",
    "function",
    "generator_function_declaration",
    "generator_function",
    "arrow_function",
    "method_definition",
];
const LOOPS: &[&str] = &[
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
];
const COMMENTS: &[&str] = &["comment", "line_comment", "block_comment"];
const LOGICAL: &[&str] = &["&&", "||", "??"];
/// Nomes que, com qualquer valor literal, são senha.
const PASSWORD_NAMES: &[&str] = &["password", "passwd", "pwd", "senha", "passphrase"];
/// Nomes que só contam como segredo se o valor tiver cara de segredo (ver `looks_secret`).
const SECRET_NAMES: &[&str] = &[
    "secret",
    "token",
    "apikey",
    "api_key",
    "privatekey",
    "accesskey",
];

pub fn run(source: &str, lang: Lang, tree: &Tree) -> Vec<Issue> {
    let mut ctx = Ctx {
        src: source,
        root: tree.root_node(),
        lang,
        index: LineIndex::new(source),
        issues: Vec::new(),
    };
    ctx.visit(tree.root_node(), 0);
    ctx.issues
}

struct Ctx<'a> {
    src: &'a str,
    root: Node<'a>,
    lang: Lang,
    index: LineIndex,
    issues: Vec<Issue>,
}

impl<'a> Ctx<'a> {
    fn js(&self) -> bool {
        matches!(self.lang, Lang::JavaScript | Lang::TypeScript | Lang::Tsx)
    }

    fn text(&self, node: Node) -> &'a str {
        &self.src[node.byte_range()]
    }

    fn span(&self, start: usize, end: usize) -> Span {
        let (line, column) = self.index.position(self.src, start);
        let (end_line, end_column) = self.index.position(self.src, end);
        Span {
            line,
            column,
            end_line,
            end_column,
        }
    }

    /// Dá para pôr um comentário de linha logo antes da linha de `byte`? Não quando o
    /// começo dela está dentro de texto: string ou template de várias linhas, filhos de
    /// JSX, comentário de bloco — lá o comentário viraria conteúdo (e não suprimiria).
    fn line_takes_comment(&self, byte: usize) -> bool {
        let line_start = self.src[..byte].rfind('\n').map_or(0, |i| i + 1);
        let indent = self.src[line_start..]
            .find(|c: char| c != ' ' && c != '\t')
            .unwrap_or(0);
        let at = line_start + indent;
        let mut node = self.root.descendant_for_byte_range(at, at);
        while let Some(n) = node {
            match n.kind() {
                // Código dentro de `{…}` do JSX ou `${…}` do template aceita comentário.
                "jsx_expression" | "template_substitution" | "interpolation"
                    if n.start_byte() < at =>
                {
                    return true
                }
                "string"
                | "template_string"
                | "comment"
                | "block_comment"
                | "jsx_element"
                | "jsx_fragment"
                | "jsx_opening_element"
                | "jsx_self_closing_element"
                | "jsx_text"
                    if n.start_byte() < at =>
                {
                    return false
                }
                _ => {}
            }
            node = n.parent();
        }
        true
    }

    fn report(&mut self, key: &'static str, at: Node, message: String, fix: Option<Fix>) {
        self.report_range(key, at.start_byte(), at.end_byte(), message, fix);
    }

    fn report_range(
        &mut self,
        key: &'static str,
        start: usize,
        end: usize,
        message: String,
        fix: Option<Fix>,
    ) {
        let Some(rule) = rule(key) else { return };
        let applies = match rule.scope {
            Scope::Any => true,
            Scope::Js => self.js(),
            Scope::Ts => matches!(self.lang, Lang::TypeScript | Lang::Tsx),
        };
        if !applies {
            return;
        }
        // Problemas de várias linhas são marcados só na primeira (como o SonarLint faz).
        let line_end = self.src[start..end].find('\n').map_or(end, |i| start + i);
        let end = if line_end > start {
            line_end
        } else {
            start + self.src[start..].chars().next().map_or(0, char::len_utf8)
        };
        let span = self.span(start, end);
        let suppressible = self.line_takes_comment(start);
        self.issues.push(Issue {
            rule: key,
            message,
            kind: rule.kind,
            severity: rule.severity,
            span,
            fix,
            suppressible,
        });
    }

    fn replace(&self, title: &str, start: usize, end: usize, text: &str) -> Fix {
        Fix {
            title: title.to_owned(),
            edits: vec![Edit {
                span: self.span(start, end),
                text: text.to_owned(),
            }],
        }
    }

    /// Remove a instrução; se ela ocupa a linha sozinha, remove a linha inteira.
    fn delete_statement(&self, title: &str, node: Node) -> Fix {
        let (start, end) = (node.start_byte(), node.end_byte());
        let line_start = self.src[..start].rfind('\n').map_or(0, |i| i + 1);
        let line_end = self.src[end..]
            .find('\n')
            .map_or(self.src.len(), |i| end + i);
        let alone = self.src[line_start..start].trim().is_empty()
            && self.src[end..line_end].trim().is_empty();
        if alone {
            let through = (line_end + 1).min(self.src.len());
            self.replace(title, line_start, through, "")
        } else {
            self.replace(title, start, end, "")
        }
    }

    /// `nesting`: níveis de if/laço/switch/try em volta (para S134), zerado em funções.
    fn visit(&mut self, node: Node<'a>, nesting: u32) {
        let kind = node.kind();
        let mut child_nesting = nesting;

        if COMMENTS.contains(&kind) {
            self.check_comment(node);
        }
        if self.js() {
            if FUNCTIONS.contains(&kind) {
                self.check_function(node);
                child_nesting = 0;
            }
            if is_control(node) {
                child_nesting = nesting + 1;
                if child_nesting == MAX_NESTING + 1 {
                    self.report(
                        "S134",
                        first_token(node),
                        format!(
                            "Controle de fluxo aninhado em {child_nesting} níveis (máximo {MAX_NESTING}). Use retornos antecipados ou extraia uma função."
                        ),
                        None,
                    );
                }
            }
            self.check_js(node);
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.visit(child, child_nesting);
        }
    }

    fn check_comment(&mut self, node: Node) {
        let text = self.text(node);
        for (tag, key) in [("TODO", "S1135"), ("FIXME", "S1134")] {
            if let Some(at) = find_word(text, tag) {
                let rest = text[at + tag.len()..]
                    .trim_start_matches([':', ' ', '-'])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches("*/")
                    .trim();
                let message = match (key, rest.is_empty()) {
                    ("S1135", true) => {
                        "TODO pendente: resolva ou leve para o quadro de tarefas.".to_owned()
                    }
                    ("S1135", false) => format!(
                        "TODO pendente: \"{rest}\". Resolva ou leve para o quadro de tarefas."
                    ),
                    (_, true) => "FIXME: defeito conhecido sem correção.".to_owned(),
                    (_, false) => format!("FIXME: \"{rest}\" — defeito conhecido sem correção."),
                };
                let start = node.start_byte() + at;
                self.report_range(key, start, start + tag.len(), message, None);
            }
        }
    }

    fn check_function(&mut self, node: Node<'a>) {
        let name = node.child_by_field_name("name");
        let label = name
            .map(|n| format!("\"{}\"", self.text(n)))
            .unwrap_or_else(|| "anônima".into());
        let at = name.unwrap_or_else(|| first_token(node));

        if let Some(body) = node.child_by_field_name("body") {
            let complexity = cognitive(body, 0, self.src);
            if complexity > MAX_COGNITIVE {
                self.report(
                    "S3776",
                    at,
                    format!(
                        "Função {label} com complexidade cognitiva {complexity} (máximo {MAX_COGNITIVE}). Divida em funções menores."
                    ),
                    None,
                );
            }
            let is_constructor = name.is_some_and(|n| self.text(n) == "constructor");
            if node.kind() != "arrow_function"
                && body.kind() == "statement_block"
                && body.named_child_count() == 0
                && !is_constructor
            {
                self.report(
                    "S1186",
                    at,
                    format!("Função {label} vazia: implemente, lance um erro ou explique num comentário."),
                    None,
                );
            }
            let lines = node.end_position().row - node.start_position().row + 1;
            if lines > MAX_FUNCTION_LINES {
                self.report(
                    "S138",
                    at,
                    format!("Função {label} com {lines} linhas (máximo {MAX_FUNCTION_LINES})."),
                    None,
                );
            }
        }
        if let Some(params) = node.child_by_field_name("parameters") {
            let count = params
                .named_children(&mut params.walk())
                .filter(|p| !COMMENTS.contains(&p.kind()))
                .count();
            if count > MAX_PARAMS {
                self.report(
                    "S107",
                    params,
                    format!("Função {label} com {count} parâmetros (máximo {MAX_PARAMS}). Agrupe-os num objeto."),
                    None,
                );
            }
        }
    }

    fn check_js(&mut self, node: Node<'a>) {
        match node.kind() {
            "statement_block" => self.check_empty_block(node),
            "catch_clause" => {
                if node
                    .child_by_field_name("body")
                    .is_some_and(|b| b.named_child_count() == 0)
                {
                    self.report(
                        "S2486",
                        first_token(node),
                        "Exceção capturada e ignorada: trate, registre ou propague o erro.".into(),
                        None,
                    );
                }
            }
            "binary_expression" => self.check_binary(node),
            "debugger_statement" => {
                // Corpo de if/laço sem chaves: apagar deixaria a linha seguinte como corpo.
                let fix = in_block(node).then(|| self.delete_statement("Remover `debugger`", node));
                self.report("S1525", node, "Remova a instrução `debugger`.".into(), fix);
            }
            "call_expression" => self.check_call(node),
            "new_expression" => {
                if node
                    .child_by_field_name("constructor")
                    .is_some_and(|c| self.text(c) == "Function")
                {
                    self.report(
                        "S1523",
                        node,
                        "`new Function` executa texto como código: risco de injeção.".into(),
                        None,
                    );
                }
            }
            "ternary_expression" => self.check_ternary(node),
            "if_statement" => self.check_if(node),
            "while_statement" | "do_statement" => {
                if let Some(cond) = node.child_by_field_name("condition") {
                    self.check_assignment_in_condition(cond);
                }
            }
            "switch_statement" => {
                let cases: Vec<Node> = node
                    .child_by_field_name("body")
                    .map(|body| body.named_children(&mut body.walk()).collect())
                    .unwrap_or_default();
                let has_default = cases.iter().any(|c| c.kind() == "switch_default");
                // Em TypeScript, casos só de strings costumam cobrir uma união
                // discriminada, cuja exaustividade o compilador já verifica.
                let union_like = matches!(self.lang, Lang::TypeScript | Lang::Tsx)
                    && !cases.is_empty()
                    && cases.iter().filter(|c| c.kind() == "switch_case").all(|c| {
                        c.child_by_field_name("value")
                            .is_some_and(|v| v.kind() == "string")
                    });
                if !has_default && !union_like {
                    self.report(
                        "S131",
                        first_token(node),
                        "`switch` sem `default`: diga o que acontece com valores inesperados."
                            .into(),
                        None,
                    );
                }
            }
            "finally_clause" => {
                if let Some(body) = node.child_by_field_name("body") {
                    self.check_jumps_in_finally(body, false);
                }
            }
            "variable_declaration" => {
                let token = first_token(node);
                if self.text(token) == "var" {
                    let fix = self.var_is_block_safe(node).then(|| {
                        self.replace(
                            "Trocar `var` por `let`",
                            token.start_byte(),
                            token.end_byte(),
                            "let",
                        )
                    });
                    self.report(
                        "S3504",
                        token,
                        "Use `let` ou `const` em vez de `var`.".into(),
                        fix,
                    );
                }
            }
            "predefined_type" => {
                if self.text(node) == "any" {
                    // Sem correção automática: `unknown` exige checagens em cada uso.
                    self.report(
                        "S4204",
                        node,
                        "`any` desliga a verificação de tipos: declare o tipo real ou use `unknown`.".into(),
                        None,
                    );
                }
            }
            "non_null_expression" => {
                let bang = node.end_byte() - 1;
                self.report_range(
                    "S2966",
                    bang,
                    node.end_byte(),
                    "Asserção de não-nulo (`!`): trate o caso nulo com `?.`, `??` ou uma verificação.".into(),
                    None,
                );
            }
            "variable_declarator" => {
                if let (Some(name), Some(value)) = (
                    node.child_by_field_name("name"),
                    node.child_by_field_name("value"),
                ) {
                    self.check_credential(name, value);
                }
            }
            "pair" => {
                if let (Some(key), Some(value)) = (
                    node.child_by_field_name("key"),
                    node.child_by_field_name("value"),
                ) {
                    self.check_credential(key, value);
                }
            }
            "assignment_expression" => {
                if let (Some(left), Some(right)) = (
                    node.child_by_field_name("left"),
                    node.child_by_field_name("right"),
                ) {
                    let name = left.child_by_field_name("property").unwrap_or(left);
                    self.check_credential(name, right);
                }
            }
            "string" | "template_string" => self.check_url(node),
            // `while (x);` e `if (x);` são o corpo da instrução: remover o `;` mudaria o
            // fluxo (a linha seguinte viraria o corpo). Só o `;` solto num bloco sobra.
            "empty_statement" if in_block(node) => {
                let fix = self.replace("Remover `;` extra", node.start_byte(), node.end_byte(), "");
                self.report("S1116", node, "Ponto e vírgula sobrando.".into(), Some(fix));
            }
            _ => {}
        }
        if node.kind() == "statement_block" || node.kind() == "program" {
            self.check_immediate_return(node);
        }
    }

    /// `var` → `let` sem mudar o significado: declaração direto no corpo de uma função
    /// (fora de blocos internos e de laços, em que `let` encolheria o escopo), e nenhum
    /// outro uso do nome na função antes dela (TDZ) nem outra `var` com o mesmo nome
    /// (redeclarar `let` é erro de sintaxe). Na dúvida, sem correção.
    fn var_is_block_safe(&self, declaration: Node<'a>) -> bool {
        let Some(body) = declaration
            .parent()
            .filter(|p| p.kind() == "statement_block")
        else {
            return false;
        };
        let function_body = body.parent().is_some_and(|f| {
            matches!(
                f.kind(),
                "function_declaration"
                    | "function_expression"
                    | "function"
                    | "arrow_function"
                    | "method_definition"
                    | "generator_function_declaration"
                    | "generator_function"
            )
        });
        if !function_body {
            return false;
        }
        let mut names = Vec::new();
        let mut cursor = declaration.walk();
        for declarator in declaration.named_children(&mut cursor) {
            match declarator.child_by_field_name("name") {
                Some(name) if name.kind() == "identifier" => names.push(self.text(name)),
                _ => return false, // desestruturação: não vale o risco
            }
        }
        // Passeio iterativo pelo corpo da função.
        let mut cursor = body.walk();
        loop {
            let node = cursor.node();
            let outside = node.end_byte() <= declaration.start_byte()
                || node.start_byte() >= declaration.end_byte();
            if node.kind() == "identifier" && names.contains(&self.text(node)) {
                let before = node.end_byte() <= declaration.start_byte();
                let redeclared = node.parent().is_some_and(|p| {
                    p.kind() == "variable_declarator"
                        && p.parent()
                            .is_some_and(|d| d.kind() == "variable_declaration")
                });
                if outside && (before || redeclared) {
                    return false;
                }
            }
            if cursor.goto_first_child() {
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() || cursor.node() == body {
                    return true;
                }
            }
        }
    }

    fn check_empty_block(&mut self, block: Node) {
        if block.named_child_count() != 0 {
            return;
        }
        let Some(parent) = block.parent() else { return };
        let what = match parent.kind() {
            "if_statement" => "if",
            "else_clause" => "else",
            "for_statement" | "for_in_statement" => "laço for",
            "while_statement" => "laço while",
            "do_statement" => "laço do",
            "finally_clause" => "finally",
            "try_statement" => "try",
            _ => return,
        };
        self.report(
            "S108",
            block,
            format!("Bloco vazio no {what}: remova ou complete o código."),
            None,
        );
    }

    fn check_binary(&mut self, node: Node<'a>) {
        let (Some(left), Some(op), Some(right)) = (
            node.child_by_field_name("left"),
            node.child_by_field_name("operator"),
            node.child_by_field_name("right"),
        ) else {
            return;
        };
        let operator = self.text(op);
        // `x == null` (e `== undefined`) cobre null e undefined de propósito: idioma aceito.
        let nullish = |n: Node| matches!(self.text(n), "null" | "undefined");
        if (operator == "==" || operator == "!=") && !nullish(left) && !nullish(right) {
            let strict = if operator == "==" { "===" } else { "!==" };
            let fix = self.replace(
                &format!("Trocar `{operator}` por `{strict}`"),
                op.start_byte(),
                op.end_byte(),
                strict,
            );
            self.report(
                "S1440",
                op,
                format!("Use `{strict}` em vez de `{operator}`: `{operator}` converte os tipos antes de comparar."),
                Some(fix),
            );
        }
        const SAME_SIDE: &[&str] = &[
            "==", "===", "!=", "!==", "&&", "||", "??", "-", "/", "%", "<", ">", "<=", ">=", "^",
            "&", "|",
        ];
        if SAME_SIDE.contains(&operator) && same_code(self.text(left), self.text(right)) {
            self.report(
                "S1764",
                node,
                format!(
                    "Os dois lados de `{operator}` são iguais (`{}`): provável erro de digitação.",
                    self.text(left).trim()
                ),
                None,
            );
        }
        if LOGICAL.contains(&operator) && !is_logical_child(node, self.src) {
            let count = count_logical(node, self.src);
            if count > MAX_LOGICAL_OPS {
                self.report(
                    "S1067",
                    node,
                    format!("Expressão com {count} operadores lógicos (máximo {MAX_LOGICAL_OPS}). Quebre em variáveis com nomes."),
                    None,
                );
            }
        }
    }

    fn check_call(&mut self, node: Node<'a>) {
        let Some(callee) = node.child_by_field_name("function") else {
            return;
        };
        match callee.kind() {
            "identifier" if self.text(callee) == "eval" => {
                self.report(
                    "S1523",
                    callee,
                    "`eval` executa texto como código: risco de injeção.".into(),
                    None,
                );
            }
            "member_expression" => {
                let (Some(object), Some(property)) = (
                    callee.child_by_field_name("object"),
                    callee.child_by_field_name("property"),
                ) else {
                    return;
                };
                let method = self.text(property);
                if self.text(object) == "console"
                    && matches!(method, "log" | "debug" | "info" | "trace" | "dir" | "table")
                {
                    let statement = node
                        .parent()
                        .filter(|p| p.kind() == "expression_statement" && in_block(*p));
                    let fix = statement
                        .map(|s| self.delete_statement(&format!("Remover `console.{method}`"), s));
                    self.report(
                        "S106",
                        callee,
                        format!("`console.{method}` esquecido: remova ou use um logger."),
                        fix,
                    );
                }
            }
            _ => {}
        }
    }

    fn check_ternary(&mut self, node: Node<'a>) {
        let (Some(yes), Some(no)) = (
            node.child_by_field_name("consequence"),
            node.child_by_field_name("alternative"),
        ) else {
            return;
        };
        if same_code(self.text(yes), self.text(no)) {
            self.report(
                "S3923",
                node,
                "Os dois resultados do ternário são iguais: a condição não tem efeito.".into(),
                None,
            );
        }
        let nested = |n: Node| unwrap_parens(n).kind() == "ternary_expression";
        let inside_ternary = node
            .parent()
            .map(unwrap_parent_parens)
            .is_some_and(|p| p.kind() == "ternary_expression");
        if !inside_ternary && (nested(yes) || nested(no)) {
            self.report(
                "S3358",
                node,
                "Ternário aninhado: troque por if/else ou uma tabela de valores.".into(),
                None,
            );
        }
    }

    fn check_if(&mut self, node: Node<'a>) {
        if let Some(cond) = node.child_by_field_name("condition") {
            self.check_assignment_in_condition(cond);
        }
        // Só a cabeça da cadeia if / else if / else olha os ramos.
        if node.parent().is_some_and(|p| p.kind() == "else_clause") {
            return;
        }
        let mut branches: Vec<Node> = Vec::new();
        let mut has_else = false;
        let mut current = node;
        loop {
            if let Some(body) = current.child_by_field_name("consequence") {
                branches.push(body);
            }
            let Some(alt) = current.child_by_field_name("alternative") else {
                break;
            };
            let Some(inner) = alt.named_child(0) else {
                break;
            };
            if inner.kind() == "if_statement" {
                current = inner;
            } else {
                branches.push(inner);
                has_else = true;
                break;
            }
        }
        if branches.len() < 2 || branches.iter().any(|b| block_is_empty(*b)) {
            return;
        }
        let first = self.text(branches[0]);
        if has_else && branches.iter().all(|b| same_code(self.text(*b), first)) {
            self.report(
                "S3923",
                first_token(node),
                "Todos os ramos do if/else fazem a mesma coisa: a condição não tem efeito.".into(),
                None,
            );
            return;
        }
        for (i, branch) in branches.iter().enumerate().skip(1) {
            if let Some(original) = branches[..i]
                .iter()
                .find(|b| same_code(self.text(**b), self.text(*branch)))
            {
                let line = original.start_position().row + 1;
                self.report(
                    "S1871",
                    *branch,
                    format!(
                        "Este ramo repete o código do ramo da linha {line}: junte as condições."
                    ),
                    None,
                );
            }
        }
    }

    fn check_assignment_in_condition(&mut self, cond: Node<'a>) {
        let inner = unwrap_parens(cond);
        if inner.kind() == "assignment_expression" {
            self.report(
                "S1121",
                inner,
                "Atribuição dentro da condição: faça antes, ou use `===` se a ideia era comparar."
                    .into(),
                None,
            );
        }
    }

    fn check_jumps_in_finally(&mut self, node: Node<'a>, in_loop: bool) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            let kind = child.kind();
            if FUNCTIONS.contains(&kind) {
                continue;
            }
            let jumps = match kind {
                "return_statement" | "throw_statement" => true,
                "break_statement" | "continue_statement" => !in_loop,
                _ => false,
            };
            if jumps {
                self.report(
                    "S1143",
                    first_token(child),
                    format!(
                        "`{}` dentro de `finally` descarta o erro ou o retorno em andamento.",
                        self.text(first_token(child))
                    ),
                    None,
                );
            }
            let loops = in_loop || LOOPS.contains(&kind) || kind == "switch_statement";
            self.check_jumps_in_finally(child, loops);
        }
    }

    fn check_credential(&mut self, name: Node<'a>, value: Node<'a>) {
        if value.kind() != "string" {
            return;
        }
        let key = self.text(name).trim_matches(['"', '\'']).to_lowercase();
        let literal = self.text(value).trim_matches(['"', '\'', '`']);
        if literal.is_empty() || literal.contains("${") {
            return;
        }
        let password =
            PASSWORD_NAMES.iter().any(|n| key.contains(n)) && looks_password(&key, literal);
        let secret = SECRET_NAMES.iter().any(|n| key.contains(n)) && looks_secret(literal);
        if password || secret {
            self.report(
                "S2068",
                value,
                format!("Credencial no código (`{}`): leia de uma variável de ambiente ou cofre de segredos.", self.text(name)),
                None,
            );
        }
    }

    fn check_url(&mut self, node: Node) {
        let text = self.text(node);
        let Some(at) = text.find("http://") else {
            return;
        };
        let rest = &text[at + 7..];
        let local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "www.w3.org"]
            .iter()
            .any(|h| rest.starts_with(h));
        if !local {
            let start = node.start_byte() + at;
            self.report_range(
                "S5332",
                start,
                start + 7,
                "URL com `http://`: os dados trafegam sem criptografia. Use `https://`.".into(),
                None,
            );
        }
    }

    /// `const x = …; return x;` em sequência.
    fn check_immediate_return(&mut self, block: Node<'a>) {
        let statements: Vec<Node> = block
            .named_children(&mut block.walk())
            .filter(|n| !COMMENTS.contains(&n.kind()))
            .collect();
        for pair in statements.windows(2) {
            let (decl, ret) = (pair[0], pair[1]);
            if decl.kind() != "lexical_declaration" || ret.kind() != "return_statement" {
                continue;
            }
            let declarators: Vec<Node> = decl
                .named_children(&mut decl.walk())
                .filter(|n| n.kind() == "variable_declarator")
                .collect();
            let [declarator] = declarators.as_slice() else {
                continue;
            };
            let (Some(name), Some(_)) = (
                declarator.child_by_field_name("name"),
                declarator.child_by_field_name("value"),
            ) else {
                continue;
            };
            let Some(returned) = ret.named_child(0) else {
                continue;
            };
            if name.kind() == "identifier"
                && returned.kind() == "identifier"
                && self.text(returned) == self.text(name)
                // Anotação de tipo na variável documenta o retorno: fica.
                && declarator.child_by_field_name("type").is_none()
            {
                self.report(
                    "S1488",
                    returned,
                    format!(
                        "`{}` é declarada só para ser retornada: retorne a expressão direto.",
                        self.text(name)
                    ),
                    None,
                );
            }
        }
    }
}

/// Valor com cara de segredo: 8+ caracteres, sem espaços, com letras e dígitos.
/// Valor que parece senha, não rótulo: `senha: "Senha"` ou `password: "Digite a senha"`
/// são textos de interface. Exige um dígito ou símbolo, sem espaço, diferente do nome.
fn looks_password(key: &str, value: &str) -> bool {
    !value.chars().any(char::is_whitespace)
        && value.chars().any(|c| !c.is_alphabetic())
        && value.to_lowercase() != key
}

/// Instrução cujo pai é uma lista de instruções (bloco, programa, `case`): pode ser
/// removida sem que outra tome o seu lugar.
fn in_block(node: Node) -> bool {
    node.parent().is_some_and(|p| {
        matches!(
            p.kind(),
            "statement_block" | "program" | "switch_case" | "switch_default"
        )
    })
}

fn looks_secret(value: &str) -> bool {
    value.len() >= 8
        && !value.contains(char::is_whitespace)
        && value.chars().any(|c| c.is_ascii_alphabetic())
        && value.chars().any(|c| c.is_ascii_digit())
}

fn is_control(node: Node) -> bool {
    let kind = node.kind();
    if kind == "if_statement" {
        // `else if` continua no mesmo nível do if original.
        return !node.parent().is_some_and(|p| p.kind() == "else_clause");
    }
    LOOPS.contains(&kind) || kind == "switch_statement" || kind == "try_statement"
}

/// Primeiro token do nó (ex.: a palavra `if`), para marcar só ela.
fn first_token(node: Node) -> Node {
    node.child(0).unwrap_or(node)
}

fn unwrap_parens(mut node: Node) -> Node {
    while node.kind() == "parenthesized_expression" {
        match node.named_child(0) {
            Some(inner) => node = inner,
            None => break,
        }
    }
    node
}

fn unwrap_parent_parens(mut node: Node) -> Node {
    while node.kind() == "parenthesized_expression" {
        match node.parent() {
            Some(parent) => node = parent,
            None => break,
        }
    }
    node
}

fn block_is_empty(node: Node) -> bool {
    node.kind() == "statement_block" && node.named_child_count() == 0
}

/// Mesmo código, ignorando espaços.
fn same_code(a: &str, b: &str) -> bool {
    let squash = |s: &str| s.split_whitespace().collect::<String>();
    squash(a) == squash(b)
}

fn find_word(text: &str, word: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    text.match_indices(word).map(|(i, _)| i).find(|&i| {
        let before = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let after = bytes
            .get(i + word.len())
            .is_none_or(|b| !b.is_ascii_alphanumeric());
        before && after
    })
}

fn operator_of<'a>(node: Node, src: &'a str) -> Option<&'a str> {
    node.child_by_field_name("operator")
        .map(|op| &src[op.byte_range()])
}

/// O nó é parte de uma expressão lógica maior (contada a partir dela).
fn is_logical_child(node: Node, src: &str) -> bool {
    let mut parent = node.parent();
    while let Some(p) = parent {
        match p.kind() {
            "parenthesized_expression" | "unary_expression" => parent = p.parent(),
            "binary_expression" => {
                return operator_of(p, src).is_some_and(|op| LOGICAL.contains(&op));
            }
            _ => return false,
        }
    }
    false
}

fn count_logical(node: Node, src: &str) -> usize {
    match node.kind() {
        "parenthesized_expression" | "unary_expression" => node
            .named_children(&mut node.walk())
            .map(|c| count_logical(c, src))
            .sum(),
        "binary_expression" => {
            let own = operator_of(node, src).is_some_and(|op| LOGICAL.contains(&op)) as usize;
            own + node
                .named_children(&mut node.walk())
                .map(|c| count_logical(c, src))
                .sum::<usize>()
        }
        _ => 0,
    }
}

/// Complexidade cognitiva (especificação do Sonar): +1 por desvio de fluxo, mais o nível
/// de aninhamento para if/laço/switch/catch/ternário; `else if` e `else` somam 1 sem
/// aninhamento; cada sequência de operadores lógicos iguais soma 1. Funções internas são
/// medidas à parte.
fn cognitive(node: Node, nesting: u32, src: &str) -> u32 {
    let kind = node.kind();
    if FUNCTIONS.contains(&kind) {
        return 0;
    }
    let children = |n: Node, level: u32| -> u32 {
        n.children(&mut n.walk())
            .map(|c| cognitive(c, level, src))
            .sum()
    };
    match kind {
        "if_statement" => {
            let else_if = node.parent().is_some_and(|p| p.kind() == "else_clause");
            let mut total = if else_if { 1 } else { 1 + nesting };
            if let Some(cond) = node.child_by_field_name("condition") {
                total += cognitive(cond, nesting, src);
            }
            if let Some(body) = node.child_by_field_name("consequence") {
                total += cognitive(body, nesting + 1, src);
            }
            if let Some(alt) = node.child_by_field_name("alternative") {
                total += cognitive(alt, nesting, src);
            }
            total
        }
        "else_clause" => match node.named_child(0) {
            Some(inner) if inner.kind() == "if_statement" => cognitive(inner, nesting, src),
            Some(inner) => 1 + cognitive(inner, nesting + 1, src),
            None => 1,
        },
        "for_statement" | "for_in_statement" | "while_statement" | "do_statement"
        | "switch_statement" | "catch_clause" | "ternary_expression" => {
            1 + nesting + children(node, nesting + 1)
        }
        "binary_expression" => {
            let op = operator_of(node, src);
            let logical = op.is_some_and(|o| LOGICAL.contains(&o));
            let continues = logical
                && node
                    .parent()
                    .is_some_and(|p| p.kind() == "binary_expression" && operator_of(p, src) == op);
            (logical && !continues) as u32 + children(node, nesting)
        }
        "break_statement" | "continue_statement" => {
            node.child_by_field_name("label").is_some() as u32
        }
        _ => children(node, nesting),
    }
}

/// Converte bytes em (linha, coluna UTF-16), ambos a partir de 1.
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(src: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(src.match_indices('\n').map(|(i, _)| i + 1));
        Self { starts }
    }

    fn position(&self, src: &str, byte: usize) -> (u32, u32) {
        let line = self.starts.partition_point(|&s| s <= byte) - 1;
        let start = self.starts[line];
        let column = src[start..byte].encode_utf16().count();
        (line as u32 + 1, column as u32 + 1)
    }
}
