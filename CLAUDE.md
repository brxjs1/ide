# CLAUDE.md

Este repositório usa um **Project Brain** em `.project/`. Antes de qualquer tarefa
não trivial, leia o que for relevante:

- `.project/README.md` — como o Brain é organizado e mantido
- `.project/conventions/` — regras de código, commits e revisão (obrigatórias)
- `.project/decisions/` — ADRs; não contradiga uma decisão aceita sem propor nova ADR
- `.project/architecture/` — visão de módulos e fluxos
- `.project/glossary.md` — termos de domínio
- `.project/memory/` — fatos aprendidos em sessões anteriores
- `docs/ROADMAP.md` — visão e fases do projeto

## Regras de trabalho

- Commits seguem `.project/conventions/commits.md` (validado por `.githooks/commit-msg`).
- Um propósito por commit. Refactor separado de mudança de comportamento.
- Antes de propor um commit, rode a skill `review-before-commit`.
- Tarefas autônomas rodam em worktree (`scripts/worktree.sh new <slug>`), nunca no branch atual.
- Quando o usuário te corrigir com uma regra geral, proponha a linha exata para
  `.project/conventions/` ou `.project/memory/` — não edite sem aprovação.

## Código

Monorepo Tauri 2 + SolidJS — ver `.project/architecture/monorepo.md`.
Lógica vive em `crates/`; `apps/desktop/src-tauri/` só tem comandos finos.

## Setup e verificação

```bash
scripts/install-hooks.sh   # ativa .githooks (commit-msg)
pnpm install
pnpm check                 # rode antes de propor qualquer commit
```
