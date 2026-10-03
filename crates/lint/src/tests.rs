use super::*;

/// (regra, linha) de cada problema.
fn found(src: &str, lang: Lang) -> Vec<(&'static str, u32)> {
    lint_source(src, lang)
        .into_iter()
        .map(|i| (i.rule, i.span.line))
        .collect()
}

fn ts(src: &str) -> Vec<(&'static str, u32)> {
    found(src, Lang::TypeScript)
}

fn has(src: &str, key: &str) -> bool {
    ts(src).iter().any(|(k, _)| *k == key)
}

#[test]
fn catalogo_completo_e_coerente() {
    assert!(rules().len() >= 25);
    let mut keys: Vec<&str> = rules().iter().map(|r| r.key).collect();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), rules().len(), "chaves repetidas");
    for r in rules() {
        assert!(
            !r.why.is_empty() && !r.fix.is_empty(),
            "{} sem textos",
            r.key
        );
        assert!(
            !r.noncompliant.is_empty() && !r.compliant.is_empty(),
            "{} sem exemplos",
            r.key
        );
    }
}

#[test]
fn igualdade_frouxa_com_correcao() {
    let src = "if (a == 1) {\n  f();\n}\nif (b != null) {\n  g();\n}\n";
    let issues = lint_source(src, Lang::TypeScript);
    let eq: Vec<_> = issues.iter().filter(|i| i.rule == "S1440").collect();
    assert_eq!(eq.len(), 1, "== null fica de fora");
    assert_eq!(
        (eq[0].span.line, eq[0].span.column, eq[0].span.end_column),
        (1, 7, 9)
    );
    let fixed = apply_fix(src, eq[0].fix.as_ref().unwrap());
    assert!(fixed.starts_with("if (a === 1)"));
}

#[test]
fn var_any_debugger_console_e_ponto_e_virgula() {
    let src =
        "function f() {\n  var x: any = 1;\n  debugger;\n  console.log(x);;\n  return x;\n}\n";
    let issues = lint_source(src, Lang::TypeScript);
    let rules: Vec<&str> = issues.iter().map(|i| i.rule).collect();
    for key in ["S3504", "S4204", "S1525", "S106", "S1116"] {
        assert!(rules.contains(&key), "faltou {key} em {rules:?}");
    }
    let mut out = src.to_owned();
    // Aplica uma correção por vez, de baixo para cima, como o editor faria.
    for key in ["S1116", "S1525", "S3504"] {
        let current = lint_source(&out, Lang::TypeScript);
        let issue = current.iter().find(|i| i.rule == key).unwrap();
        out = apply_fix(&out, issue.fix.as_ref().unwrap());
    }
    assert_eq!(
        out,
        "function f() {\n  let x: any = 1;\n  console.log(x);\n  return x;\n}\n"
    );
    // `any` → `unknown` quebraria a compilação nos usos: sem correção automática.
    assert!(issues
        .iter()
        .find(|i| i.rule == "S4204")
        .unwrap()
        .fix
        .is_none());
    // Em JavaScript, `any` não existe: a regra só de TS não roda.
    assert!(!found("var x = 1;", Lang::JavaScript)
        .iter()
        .any(|(k, _)| *k == "S4204"));
}

#[test]
fn console_dentro_de_linha_sem_remover_outras_instrucoes() {
    let src = "a(); console.log(1); b();\n";
    let issue = lint_source(src, Lang::JavaScript)
        .into_iter()
        .find(|i| i.rule == "S106")
        .unwrap();
    assert_eq!(apply_fix(src, issue.fix.as_ref().unwrap()), "a();  b();\n");
}

#[test]
fn blocos_vazios_catch_e_funcoes() {
    let src = "function vazia() {}\nfunction comentada() {\n  // nada a fazer\n}\nif (a) {} else { b(); }\ntry { c(); } catch (e) {}\nclass K { constructor(private x: number) {} }\nconst noop = () => {};\n";
    let got = ts(src);
    assert!(got.contains(&("S1186", 1)));
    assert!(
        !got.iter().any(|(k, l)| *k == "S1186" && *l != 1),
        "{got:?}"
    );
    assert!(got.contains(&("S108", 5)));
    assert!(got.contains(&("S2486", 6)));
}

#[test]
fn complexidade_cognitiva() {
    let simples = "function f(a) {\n  if (a) { return 1; }\n  return 0;\n}\n";
    assert!(!has(simples, "S3776"));
    // if (1) + for aninhado (2) + if aninhado 2x (3) + && (1) + else (1) ... passa de 15.
    let complexa = "function g(a, b, c) {\n  if (a) {\n    for (const x of b) {\n      if (x && c) {\n        while (x) {\n          if (c || a) { break; } else if (b) { continue; } else { x--; }\n        }\n      }\n    }\n  } else if (b) {\n    try { a(); } catch (e) { if (e) { throw e; } }\n  }\n  return a ? b : c;\n}\n";
    let issue = lint_source(complexa, Lang::JavaScript)
        .into_iter()
        .find(|i| i.rule == "S3776")
        .expect("deveria passar de 15");
    assert_eq!(issue.span.line, 1);
    assert!(issue.message.contains("\"g\""), "{}", issue.message);
}

#[test]
fn aninhamento_parametros_e_expressoes() {
    let fundo = "if (a) { for (;;) { while (b) { switch (c) { default: try { if (d) {} } catch (e) { throw e; } } } } }";
    assert!(has(fundo, "S134"));
    assert!(has(
        "function f(a, b, c, d, e, f2, g, h) { return a; }",
        "S107"
    ));
    assert!(!has(
        "function f(a, b, c, d, e, f2, g) { return a; }",
        "S107"
    ));
    assert!(has("if (a && b || c && d && !e) { f(); }", "S1067"));
    assert!(!has("if (a && b || c) { f(); }", "S1067"));
}

#[test]
fn ternarios_e_ramos_iguais() {
    assert!(has("const c = a ? 1 : b ? 2 : 3;", "S3358"));
    assert!(has("const t = vip ? 0.1 : 0.1;", "S3923"));
    assert!(has("if (a) { f(); } else { f(); }", "S3923"));
    let cadeia =
        "if (a) {\n  salvar();\n} else if (b) {\n  avisar();\n} else if (c) {\n  salvar();\n}\n";
    assert!(ts(cadeia).contains(&("S1871", 5)));
    assert!(has("if (x.id === x.id) { f(); }", "S1764"));
    assert!(!has("if (x.id === y.id) { f(); }", "S1764"));
}

#[test]
fn switch_finally_e_atribuicao() {
    assert!(has("switch (s) { case 1: f(); break; }", "S131"));
    // União discriminada em TypeScript: o compilador cuida da exaustividade.
    assert!(!has(
        "switch (m.type) { case \"a\": f(); break; case \"b\": g(); }",
        "S131"
    ));
    assert!(
        found("switch (m.type) { case \"a\": f(); }", Lang::JavaScript)
            .iter()
            .any(|(k, _)| *k == "S131")
    );
    assert!(!has(
        "switch (s) { case 1: f(); break; default: g(); }",
        "S131"
    ));
    let finally = "function f() {\n  try { return 1; } finally {\n    for (const x of xs) { if (x) break; }\n    return 0;\n  }\n}\n";
    let got = ts(finally);
    assert!(got.contains(&("S1143", 4)), "{got:?}");
    assert_eq!(
        got.iter().filter(|(k, _)| *k == "S1143").count(),
        1,
        "break no laço é permitido"
    );
    assert!(has("if ((u = buscar())) { f(); }", "S1121"));
    assert!(has("while ((n = next())) { f(); }", "S1121"));
}

#[test]
fn seguranca() {
    assert!(has("const password = \"admin123\";", "S2068"));
    assert!(has("const cfg = { apiKey: \"sk9f8a7d6s5\" };", "S2068"));
    // `token` de tema/sintaxe não é segredo.
    assert!(!has(
        "const regra = { token: \"comment\", foreground: \"6b6b70\" };",
        "S2068"
    ));
    assert!(!has("const password = process.env.PASS;", "S2068"));
    assert!(!has("const password = \"\";", "S2068"));
    assert!(has("fetch(\"http://api.exemplo.com\");", "S5332"));
    assert!(!has("fetch(\"http://localhost:3000\");", "S5332"));
    assert!(has("eval(codigo);", "S1523"));
    assert!(has("const f = new Function(\"a\", corpo);", "S1523"));
    let issue = lint_source("const senha = \"x9!\";", Lang::TypeScript).remove(0);
    assert_eq!(
        (issue.kind, issue.severity),
        (Kind::Vulnerability, Severity::Blocker)
    );
}

#[test]
fn retorno_imediato_e_nao_nulo() {
    assert!(has(
        "function f() {\n  const t = a + b;\n  return t;\n}",
        "S1488"
    ));
    assert!(!has(
        "function f() {\n  const t: number = a + b;\n  return t;\n}",
        "S1488"
    ));
    let issue = lint_source("const n = usuario!.nome;", Lang::TypeScript)
        .into_iter()
        .find(|i| i.rule == "S2966")
        .unwrap();
    assert_eq!((issue.span.column, issue.span.end_column), (18, 19));
}

#[test]
fn todo_fixme_em_qualquer_linguagem() {
    let rs = found(
        "// TODO: validar\nfn main() {} // FIXME estoura\n",
        Lang::Rust,
    );
    assert_eq!(rs, vec![("S1135", 1), ("S1134", 2)]);
    let py = found("# TODO revisar\n", Lang::Python);
    assert_eq!(py, vec![("S1135", 1)]);
    // "TODOS" não é TODO.
    assert!(found("// TODOS os casos\n", Lang::Rust).is_empty());
    // Regras de JavaScript não rodam em Rust.
    assert!(!found("fn f() { if a == b {} }", Lang::Rust)
        .iter()
        .any(|(k, _)| *k == "S1440"));
}

#[test]
fn supressao() {
    assert!(!has("var a = 1; // NOSONAR", "S3504"));
    assert!(!has("// ide-lint-disable-next-line\nvar a = 1;", "S3504"));
    assert!(!has(
        "// ide-lint-disable-next-line S3504\nvar a = 1;",
        "S3504"
    ));
    assert!(has(
        "// ide-lint-disable-next-line S1440\nvar a = 1;",
        "S3504"
    ));
}

#[test]
fn colunas_em_utf16() {
    // "ção" e o emoji contam como 3 e 2 unidades UTF-16, não como bytes.
    let src = "const s = \"ação 😀\"; if (a == 1) f();";
    let issue = lint_source(src, Lang::JavaScript)
        .into_iter()
        .find(|i| i.rule == "S1440")
        .unwrap();
    let utf16_col = src[..src.find("==").unwrap()].encode_utf16().count() as u32 + 1;
    assert_eq!(issue.span.column, utf16_col);
    let fixed = apply_fix(src, issue.fix.as_ref().unwrap());
    assert!(fixed.ends_with("if (a === 1) f();"));
}

#[test]
fn notas_no_estilo_sonar() {
    let none = ratings(&[], 100);
    assert_eq!(
        (none.maintainability, none.reliability, none.security),
        ('A', 'A', 'A')
    );
    let issues = lint_source(
        "const password = \"x9!\";\nif (a === a) { f(); }\n",
        Lang::JavaScript,
    );
    let r = ratings(&issues, 2);
    assert_eq!(r.security, 'E', "vulnerabilidade bloqueante");
    assert_eq!(r.reliability, 'C', "bug maior");
    assert!(r.debt_minutes >= 32);
}

#[test]
fn projeto_respeita_gitignore_e_ordena_pelos_piores() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    std::fs::write(root.join(".gitignore"), "dist/\n").unwrap();
    std::fs::write(
        root.join("src/leve.ts"),
        "// TODO depois\nexport const a = 1;\n",
    )
    .unwrap();
    std::fs::write(
        root.join("src/grave.ts"),
        "export const token = \"ghp_9aZ8x7Y6w5\";\n",
    )
    .unwrap();
    std::fs::write(root.join("src/limpo.ts"), "export const b = 2;\n").unwrap();
    std::fs::write(root.join("dist/gerado.js"), "var x = 1;\n").unwrap();
    std::fs::write(root.join("node_modules/pkg/i.js"), "var x = 1;\n").unwrap();
    std::fs::write(
        root.join("src/min.js"),
        format!("var x = \"{}\";\n", "a".repeat(2000)),
    )
    .unwrap();

    let report = lint_project(root, 100);
    let paths: Vec<&str> = report.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["src/grave.ts", "src/leve.ts"]);
    assert_eq!(report.files_analyzed, 3);
    assert_eq!(report.ratings.security, 'E');
    assert!(!report.truncated);
    assert!(lint_project(root, 1).truncated);

    let json = serde_json::to_value(&report.files[0].issues[0]).unwrap();
    assert_eq!(json["rule"], "S2068");
    assert_eq!(json["kind"], "vulnerability");
    assert_eq!(json["severity"], "blocker");
    assert_eq!(json["line"], 1);
}

#[test]
fn arquivo_aninhado_demais_nao_derruba_o_processo() {
    // 50 mil níveis de colchetes, quebrados em linhas curtas (escapa do filtro de
    // minificado). Antes, a recursão das verificações estourava a pilha.
    let mut src = String::from("const a = ");
    for i in 0..50_000 {
        src.push('[');
        if i % 400 == 399 {
            src.push('\n');
        }
    }
    src.push_str(&"]".repeat(50_000));
    src.push_str(";\nvar b = 1;\n");
    // Numa thread com a pilha padrão de 2 MB, como as do runtime do Tauri.
    let issues = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || lint_source(&src, Lang::TypeScript))
        .unwrap()
        .join()
        .expect("não pode estourar a pilha");
    assert!(issues.is_empty(), "árvore funda demais não é analisada");
}

#[test]
fn lint_path_respeita_os_limites() {
    let dir = tempfile::tempdir().unwrap();
    let min = dir.path().join("min.js");
    std::fs::write(&min, format!("var x = \"{}\";\n", "a".repeat(2000))).unwrap();
    assert!(
        lint_path(&min).unwrap().is_empty(),
        "minificado fica de fora"
    );
    let ok = dir.path().join("ok.js");
    std::fs::write(&ok, "var x = 1;\n").unwrap();
    assert_eq!(lint_path(&ok).unwrap()[0].rule, "S3504");
}

/// Correção da regra `key` no primeiro problema dela, se houver.
fn fix_of(src: &str, key: &str) -> Option<Fix> {
    lint_source(src, Lang::TypeScript)
        .into_iter()
        .find(|i| i.rule == key)
        .and_then(|i| i.fix)
}

#[test]
fn correcoes_nao_mudam_o_fluxo_em_corpo_sem_chaves() {
    // `;` como corpo de laço ou if é a instrução vazia de propósito: nem é problema.
    for src in [
        "while (poll());\nnext();\n",
        "if (x);\nnext();\n",
        "for (const a of b);\nnext();\n",
    ] {
        assert!(!has(src, "S1116"), "{src}");
    }
    // Apagar o corpo sem chaves faria a linha seguinte virar o corpo: aponta, sem corrigir.
    for (src, key) in [
        ("if (dbg)\n  console.log(x);\nnext();\n", "S106"),
        ("if (x) debugger;\nnext();\n", "S1525"),
        ("for (;;) console.log(1);\n", "S106"),
    ] {
        assert!(has(src, key), "{src}");
        assert!(fix_of(src, key).is_none(), "{src}");
    }
    // Dentro de bloco e em `case`, segue com correção.
    let src = "switch (a) {\n  case 1:\n    debugger;\n    break;\n}\n";
    assert!(fix_of(src, "S1525").is_some());
    let src = "if (x) {\n  f();;\n}\n";
    assert_eq!(
        apply_fix(src, &fix_of(src, "S1116").unwrap()),
        "if (x) {\n  f();\n}\n"
    );
}

#[test]
fn var_para_let_so_quando_nao_muda_o_escopo() {
    let ok = "function f() {\n  var a = 1;\n  return a;\n}\n";
    assert_eq!(
        apply_fix(ok, &fix_of(ok, "S3504").unwrap()),
        "function f() {\n  let a = 1;\n  return a;\n}\n"
    );
    for src in [
        // Dentro de bloco interno: o uso fora daria ReferenceError com `let`.
        "function f(c) {\n  if (c) { var x = 1; }\n  return x;\n}\n",
        // Redeclaração: `let` duas vezes é erro de sintaxe.
        "function f() {\n  var a = 1;\n  var a = 2;\n  return a;\n}\n",
        // Uso antes da declaração (hoisting): com `let`, zona morta temporal.
        "function f() {\n  g(a);\n  var a = 1;\n}\n",
        // Laço: `var` é um só para todas as voltas.
        "function f() {\n  for (var i = 0; i < 3; i++) {}\n  return i;\n}\n",
        // Escopo do script: `var` vira propriedade global.
        "var a = 1;\n",
        // Desestruturação.
        "function f(o) {\n  var { a } = o;\n  return a;\n}\n",
    ] {
        assert!(has(src, "S3504"), "{src}");
        assert!(fix_of(src, "S3504").is_none(), "{src}");
    }
}

#[test]
fn comparacao_com_undefined_e_null_e_aceita() {
    assert!(!has("if (a == undefined) f();", "S1440"));
    assert!(!has("if (undefined != a) f();", "S1440"));
}

#[test]
fn rotulos_de_senha_nao_sao_credenciais() {
    for src in [
        "const t = { senha: \"Senha\", password: \"Password\" };",
        "const t = { senha: \"Digite a senha\" };",
        "const label = { passwordHint: \"forte\" };",
    ] {
        assert!(!has(src, "S2068"), "{src}");
    }
    assert!(has("const db = { password: \"s3gredo\" };", "S2068"));
}

#[test]
fn info_nao_rebaixa_a_nota() {
    let issue = |kind, severity| Issue {
        rule: "S1135",
        message: String::new(),
        kind,
        severity,
        span: Span {
            line: 1,
            column: 1,
            end_line: 1,
            end_column: 2,
        },
        fix: None,
        suppressible: true,
    };
    let r = ratings(
        &[
            issue(Kind::Bug, Severity::Info),
            issue(Kind::Vulnerability, Severity::Info),
        ],
        100,
    );
    assert_eq!((r.reliability, r.security), ('A', 'A'));
    let r = ratings(&[issue(Kind::Bug, Severity::Minor)], 100);
    assert_eq!(r.reliability, 'B');
}

#[test]
fn expressao_longa_nao_estoura_a_pilha() {
    // `0 + 1 + … + n`: cada `+` é um nível a mais na árvore.
    let run = |terms: usize| {
        let mut src = String::from("const a = 0");
        for i in 1..terms {
            src.push_str(&format!(" + {i}"));
            if i % 50 == 0 {
                src.push('\n');
            }
        }
        src.push_str(";\nvar b = 1;\n");
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || lint_source(&src, Lang::TypeScript))
            .unwrap()
            .join()
            .expect("não pode estourar a pilha")
    };
    // Logo abaixo do limite de profundidade ainda é analisada…
    assert!(run(MAX_TREE_DEPTH - 20).iter().any(|i| i.rule == "S3504"));
    // …e bem acima, pulada sem derrubar o processo.
    assert!(run(8_000).is_empty());
}

#[test]
fn ignorar_na_linha_so_fora_de_texto() {
    let suppressible = |src: &str, key: &str, lang: Lang| {
        lint_source(src, lang)
            .into_iter()
            .find(|i| i.rule == key)
            .unwrap_or_else(|| panic!("faltou {key} em {src}"))
            .suppressible
    };
    assert!(suppressible(
        "fetch(\"http://a.com\");",
        "S5332",
        Lang::TypeScript
    ));
    // Linha 2 de um template: o comentário entraria na string.
    assert!(!suppressible(
        "const u = `\nhttp://a.com/x`;\n",
        "S5332",
        Lang::TypeScript
    ));
    // Filho de JSX: o comentário seria texto renderizado.
    assert!(!suppressible(
        "const v = (\n  <div>\n    {console.log(1)}\n  </div>\n);\n",
        "S106",
        Lang::Tsx
    ));
    // Dentro das chaves, é código: aceita.
    assert!(suppressible(
        "const v = (
  <div>{
    console.log(1)
  }</div>
);
",
        "S106",
        Lang::Tsx
    ));
    assert!(!suppressible(
        "const v = (\n  <a\n    href=\"http://a.com\">x</a>\n);\n",
        "S5332",
        Lang::Tsx
    ));
    // Comentário de bloco de várias linhas.
    assert!(!suppressible(
        "/*\n TODO: depois\n*/\n",
        "S1135",
        Lang::TypeScript
    ));
}
