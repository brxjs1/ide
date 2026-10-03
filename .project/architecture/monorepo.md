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
│   ├── core/               # ide-core — git: projeto, worktrees, diff; arquivos (files.rs);
│   │                       #            quadro de tarefas (board.rs, .project/tasks/*.md)
│   ├── syntax/             # ide-syntax — tree-sitter: outline e busca de símbolos
│   ├── lsp/                # ide-lsp — cliente LSP + gerenciador de servidores por linguagem
│   ├── lint/               # ide-lint — regras de qualidade estilo SonarLint, notas A–E
│   ├── mcp/                # ide-mcp — servidor MCP stdio (bin) com as ferramentas do agente
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

Editor (lib/editor.ts)
  FilesPanel → files_tree / file_read → ide_core::files (resolve: sem `..` nem symlink fora)
  Monaco → lsp_open/change/save/close, lsp_hover, lsp_definition → editor.rs
    → ide_lsp::LspManager (um servidor por linguagem, do PATH) ─ spawn_blocking
  servidor publica diagnósticos → emit("lsp://diagnostics") → markers do Monaco
  Ctrl+S → file_write (atômico) → lsp_change + lsp_save (rust-analyzer checa no save)

Qualidade de código (ADR 0006)
  editor: texto atual → lint_source (debounce) → ide_lint::lint_source → markers "ide-lint"
  painel Problemas: lint_project (a cada mudança no git) + diagnósticos do LSP (com `code`)
  Error Lens (lib/editor.ts): a cada mudança de marcadores, a mais grave da linha como
    texto injetado no fim; erros do compilador passam por lib/explain.ts (TS/Rust → pt-BR)
  quick fixes: Issue.fix (edições) → code action do Monaco; "ignorar" insere o comentário

Quadro de tarefas (ADR 0006)
  BoardView → board_list/create/set_status/set_meta/delete → ide_core::board (.md)
  Executar com o agente → task_create (worktree) + Status: em progresso + Worktree: task/<slug>
  Integrar → Status: concluída; Descartar → a fazer (merge ignora mudanças em .project/tasks/)

Ferramentas do agente (ADR 0004)
  ide_agent::locate → IDE_MCP_COMMAND (env do sidecar) → server.ts::ideMcp
  → SDK sobe `ide-mcp --root <cwd>` por sessão → outline_file, find_symbol,
    project_tree (ide-syntax/ide-core), code_issues (ide-lint), task_board (board) — só
    leem, pré-aprovadas —, diagnostics, definition (ide-lsp — pedem aprovação)
```

## UI (apps/desktop/src)

```text
App.tsx            Workspace: grid sidebar | main (topbar, avisos, thread, terminal) | painel;
                   atalhos globais (Ctrl+K/P/N/B/J) e as ações da paleta
styles.css         tokens do tema preto (ADR 0005); main e painel são cards `.surface`
lib/agent.ts       store das conversas + sessão do SDK; `revision` reativa para persistir
lib/threads.ts     threads por projeto no localStorage (sem apagar as de outros projetos)
lib/tasks.ts       thread em worktree, revisão de tarefa e do working tree
lib/sentinel.ts    agente em background (ociosidade → revisão leve; respeita orçamento)
lib/banners.ts     avisos no topo
lib/editor.ts      abas abertas, salvar, markers e providers LSP do Monaco
lib/monaco.ts      workers, tema e linguagens do Monaco
lib/fuzzy.ts       busca aproximada da paleta de comandos
lib/quality.ts     regras, problemas ao vivo/do projeto, preferências do Error Lens
lib/explain.ts     gerador de explicações dos erros do compilador (TS e Rust)
components/        Sidebar, TopBar, ThreadView (+ SentinelView), Composer, ChatItem,
                   EditorView, FilesPanel, CommandPalette (Ctrl+K / Ctrl+P), BoardView,
                   ProblemsPanel,
                   RightPanel (DiffPanel, FilesPanel, TimelinePanel, TodayPanel), Banners, Terminal
```

## Protocolo do agente

Definido em `packages/agent/src/protocol.ts` e espelhado em `crates/agent/src/lib.rs`
(enums serde) e `apps/desktop/src/lib/agent.ts`. **Mudou um, mude os três** — os testes
de serialização em `crates/agent` pegam divergências de formato.

Cada mensagem carrega uma `conversation`. O `prompt` aceita `model`, `effort` e `resume`
(sessão + custo acumulado, para continuar após reiniciar); o `done` traz `costUsd` (só deste
pedido) e `costTotal` (acumulado da sessão). Cada conversa tem sua sessão do SDK e roda em
paralelo às outras: `t:<id>` (thread local), `task:<slug>`, `review:<slug>` e `watch:main`
(Sentinela, sujeita ao orçamento diário — ver ADR 0003).

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
a da máquina) e inclui `resources/agent/` no instalador. O mesmo script compila `ide-mcp` em release e o
copia para `src-tauri/binaries/ide-mcp-<triple>` (`externalBin`). Em runtime o sidecar é procurado
em `IDE_AGENT_SCRIPT` → recursos do app → `packages/agent/dist` (dev).

`pnpm dev`, `pnpm check` e o CI não usam esse config, então não precisam do deploy.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `IDE_AGENT_SCRIPT` | caminho do sidecar; tem prioridade sobre o empacotado e o build local |
| `IDE_NODE` | executável do Node (padrão: `node` do PATH) |
| `IDE_MCP_COMMAND` | binário `ide-mcp`; o Rust preenche (binário ao lado do executável do app; em dev, `target/debug`) e repassa ao sidecar |

Para testar a UI sem gastar API, aponte `IDE_AGENT_SCRIPT` para um script que fale o
protocolo (veja o sidecar falso em `crates/agent/src/lib.rs`, testes).
