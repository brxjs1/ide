# 0001 — Construir sobre o Claude Agent SDK

- Status: aceita
- Data: 2026-10-02

## Contexto

O ambiente precisa de um runtime de agente (loop, tools, subagentes, permissões, hooks).
O core do app será Rust (Tauri 2), mas o Agent SDK é TypeScript/Python.

## Decisão

- O loop do agente roda em um **sidecar Node** com o Claude Agent SDK.
- O core Rust expõe suas capacidades (PTY, git, tree-sitter, LSP, índice, timeline)
  como um **servidor MCP** consumido pelo sidecar.
- Project Brain usa o formato nativo (`CLAUDE.md`, `.claude/agents`, `.claude/skills`)
  mais `.project/` para conhecimento estruturado.
- Níveis de autonomia mapeiam para permission modes do SDK; modo autônomo
  sempre em git worktree.

## Consequências

- ✅ Nada de reimplementar loop de agente em Rust.
- ✅ A Fase 0 funciona hoje usando só Claude Code.
- ❌ Dois runtimes (Rust + Node) para empacotar no Tauri.
