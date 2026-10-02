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
│   ├── core/               # ide-core — git: projeto, worktrees, diff
│   ├── pty/                # ide-pty — terminais (portable-pty)
│   ├── timeline/           # ide-timeline — eventos em SQLite
│   └── agent/              # ide-agent — processo do sidecar + protocolo tipado
└── packages/
    └── agent/              # @ide/agent — sidecar Node com o Claude Agent SDK
```

## Regras

- **Lógica vive em `crates/`, nunca em `src-tauri/`.** Comandos Tauri só convertem
  argumentos e erros. Assim o core é testável e reutilizável pelo servidor MCP.
- **Tipos IPC:** structs do core usam `serde(rename_all = "camelCase")`; o espelho
  TypeScript fica em `apps/desktop/src/lib/ipc.ts`.
- **Git via CLI** (`ide_core::git::run`), sempre com argumentos separados, nunca shell.
- **Permissões Tauri** mínimas em `src-tauri/capabilities/` — adicione plugin por
  plugin, conforme a necessidade.

## Fluxos

```text
Comando simples
  App.tsx → lib/ipc.ts → invoke("changed_files") → commands.rs → ide_core::diff

Terminal (bytes brutos, sem JSON)
  Terminal.tsx ─ invoke("pty_spawn", Channel) → terminal.rs → ide_pty::PtyManager
  thread de leitura ─ InvokeResponseBody::Raw → Channel → xterm.write(Uint8Array)

Agente
  AgentPanel → lib/agent.ts → invoke("agent_send", Inbound) → agent.rs
    → ide_agent::AgentProcess ─stdin JSON lines→ packages/agent (AgentServer → SDK query())
    ←stdout JSON lines─ Outbound → grava timeline → emit("agent://message") → store Solid
  Permissão: SDK canUseTool → permission_request → cartão na UI → permission_response

Tarefa (lib/tasks.ts)
  task_create → ide_core::tasks::create (worktree task/<slug>, objetivo na config do branch)
  → prompt na conversa "task:<slug>" em modo full (cwd = worktree)
  → done sem erro → conversa "review:<slug>" é reiniciada e recebe o prompt de revisão
    em modo review → veredito extraído do texto (lib/prompts.ts::parseVerdict)
  → Integrar: task_merge (merge --no-ff) + task_discard
```

## Protocolo do agente

Definido em `packages/agent/src/protocol.ts` e espelhado em `crates/agent/src/lib.rs`
(enums serde) e `apps/desktop/src/lib/agent.ts`. **Mudou um, mude os três** — os testes
de serialização em `crates/agent` pegam divergências de formato.

Cada mensagem carrega uma `conversation`. Cada conversa tem sua sessão do SDK e roda em
paralelo às outras: `main` (chat), `task:<slug>` e `review:<slug>`.

| Autonomia | `permissionMode` do SDK | Aprovação na UI | Restrição |
|---|---|---|---|
| `plan` | `plan` | — (nada é modificado) | — |
| `assisted` | `default` | edições e comandos | — |
| `autonomous` | `acceptEdits` | comandos | — |
| `full` | `bypassPermissions` | nenhuma | só worktree de tarefa |
| `review` | `bypassPermissions` + sem `Edit`/`Write` | nenhuma | só worktree de tarefa |

A restrição é verificada em `agent_send` (Rust). Ver ADR 0002.

## Empacotamento do sidecar

`pnpm build` usa `src-tauri/tauri.bundle.conf.json`, que roda `scripts/bundle-sidecar.mjs`
(build + `pnpm deploy --prod` com `node-linker=hoisted`, sem a variante de libc que não é
a da máquina) e inclui `resources/agent/` no instalador. Em runtime o sidecar é procurado
em `IDE_AGENT_SCRIPT` → recursos do app → `packages/agent/dist` (dev).

`pnpm dev`, `pnpm check` e o CI não usam esse config, então não precisam do deploy.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `IDE_AGENT_SCRIPT` | caminho do sidecar; tem prioridade sobre o empacotado e o build local |
| `IDE_NODE` | executável do Node (padrão: `node` do PATH) |

Para testar a UI sem gastar API, aponte `IDE_AGENT_SCRIPT` para um script que fale o
protocolo (veja o sidecar falso em `crates/agent/src/lib.rs`, testes).
