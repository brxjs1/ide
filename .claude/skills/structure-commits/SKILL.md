---
name: structure-commits
description: Divide um working tree com mudanças misturadas em commits atômicos com mensagens no padrão do projeto. Use quando o usuário pedir para organizar, dividir ou estruturar commits, ou quando o diff tiver mais de um propósito.
---

# Estruturar commits

Regras em `.project/conventions/commits.md`.

1. **Inventário.** `git status --short` e `git diff HEAD` (inclua untracked relevantes).
2. **Classificar cada hunk** por propósito: refactor, formatação, fix, feature,
   teste, docs, deps. Hunks de teste acompanham o código que testam.
3. **Propor o plano** antes de tocar em qualquer coisa:

```text
Commit 1  refactor(core): extrair parse_config para módulo próprio
          src/config.rs (todo), src/main.rs (hunks 1-2)
Commit 2  fix(core): tratar arquivo de config vazio
          src/config.rs (hunk 3), tests/config.rs
Commit 3  docs(brain): registrar convenção de erros
          .project/conventions/rust.md
```

   Ordem: formatação → refactor → fix → feature → docs. Cada commit deve compilar.
4. **Aguardar aprovação** do usuário.
5. **Executar** com stage não interativo: `git add <arquivo>` para arquivos inteiros;
   para hunks parciais gere um patch (`git diff <arquivo> > /tmp/x.patch`, edite e
   `git apply --cached`). Nunca use `git add -p`/`-i` (interativos).
6. Após cada commit, se houver comando de teste rápido, rode-o. Se falhar, pare e reporte.
7. Ao final, mostre `git log --oneline -n <N>`.

Nunca faça push, amend em commits já publicados, ou rebase sem pedido explícito.
