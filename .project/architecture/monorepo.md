# Monorepo

```text
ide/
├── Cargo.toml              # workspace Rust: crates/* + apps/desktop/src-tauri
├── package.json            # scripts da raiz (dev, build, check)
├── pnpm-workspace.yaml     # apps/*, packages/*
├── apps/
│   └── desktop/            # @ide/desktop — Tauri 2 + SolidJS + Vite
│       ├── src/            # UI Solid
│       │   └── lib/ipc.ts  # wrappers tipados dos comandos Tauri
│       └── src-tauri/      # crate ide-desktop: só comandos finos, sem lógica
├── crates/
│   └── core/               # ide-core — lógica pura (git, projeto), sem Tauri
└── packages/               # (futuro) sidecar do agente, tipos compartilhados
```

## Regras

- **Lógica vive em `crates/`, nunca em `src-tauri/`.** Comandos Tauri só convertem
  argumentos e erros. Assim o core é testável e reutilizável pelo servidor MCP.
- **Tipos IPC:** structs do core usam `serde(rename_all = "camelCase")`; o espelho
  TypeScript fica em `apps/desktop/src/lib/ipc.ts`.
- **Git via CLI** (`ide_core::git::run`), sempre com argumentos separados, nunca shell.
- **Permissões Tauri** mínimas em `src-tauri/capabilities/` — adicione plugin por
  plugin, conforme a necessidade.

## Fluxo de uma chamada

```text
App.tsx → ipc.projectInfo() → invoke("project_info")
  → src-tauri/src/commands.rs::project_info
  → ide_core::ProjectInfo::load → git rev-parse / status / worktree list
```

## Próximos crates (Fase 1)

| Crate | Papel |
|---|---|
| `crates/pty` | processos e terminal (portable-pty) |
| `crates/timeline` | eventos em SQLite |
| `crates/mcp` | servidor MCP expondo core/pty/timeline ao agente |
| `packages/agent` | sidecar Node com o Claude Agent SDK |
