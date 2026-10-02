# Roadmap — AI Development OS pessoal

> Produto real: **Rust Core + Agent Runtime + Project Brain**.
> O editor é só a interface — e é a última coisa a construir.

## Princípios

1. **Local-first.** Nada de servidor, banco remoto ou conta. SQLite + arquivos.
2. **Não reimplementar o que o Claude Agent SDK já faz** (loop do agente, tools de
   filesystem/bash/grep, subagentes, permission modes, hooks). Construir em cima.
3. **Git é a fonte da verdade.** Checkpoints são commits; isolamento é worktree;
   histórico é contexto para o agente.
4. **"Seguro" é objetivo:** testes + lint + typecheck passaram, dentro de um worktree,
   com diff para aprovação.
5. **O Brain é vivo:** o agente propõe atualizações quando é corrigido; você aprova.

## Arquitetura alvo

```text
Tauri 2 (Rust)                         Sidecar Node (Claude Agent SDK)
├── Process Manager (PTY)    ◄─MCP──── Orchestrator + subagentes
├── Git (worktrees, log, blame)        ├── reviewer / security-reviewer
├── Tree-sitter / LSP                  ├── code-reader
├── Indexer (ripgrep + SQLite)         └── commit-historian
├── Timeline (SQLite)
└── MCP server  ──────────────────────► tools expostas ao agente
        │
SolidJS UI: chat · diff · terminal · timeline · (Monaco, fase 3)
```

## Módulos

### 1. Project Brain (`.project/`)
- `architecture/`, `decisions/` (ADRs), `conventions/`, `glossary.md`, `tasks/`, `memory/`.
- **Learning loop:** quando você corrige o agente ("não faça X"), ele propõe uma
  linha nova em `conventions/` ou `memory/` — você aceita ou rejeita.
- **Carregamento seletivo:** só entra no contexto o que é relevante para os arquivos
  da tarefa (ex.: mexeu em `*.rs` → `conventions/rust.md`).
- **Detector de drift:** avisa quando o código contradiz uma decisão/convenção.

### 2. Commits — leitura
- **Explicar commit:** intenção, impacto, risco, arquivos, testes cobrindo a mudança.
- **Explicar range / branch:** "o que mudou desde a v1.2" ou "nas últimas 2 semanas em `auth/`".
- **Por que esta linha existe?** blame → commit → mensagem → ADR/tarefa relacionada.
- **Narrativa de um módulo:** a história de um arquivo/diretório em linguagem natural.
- **Bisect assistido:** o agente conduz `git bisect run` com um teste de reprodução.
- **Changelog / release notes** gerados a partir de Conventional Commits.

### 3. Commits — escrita e estrutura
- **Padrão:** Conventional Commits com escopos do projeto (`.project/conventions/commits.md`).
- **Validação:** hook `commit-msg` (`.githooks/commit-msg`).
- **Estruturação:** dividir um working tree bagunçado em commits atômicos
  (um propósito por commit, refactor separado de comportamento, testes junto do código).
- **Mensagem gerada a partir do diff**, com corpo "por quê / o quê / como testar".
- **Auditoria de histórico:** nota de qualidade dos últimos N commits (atomicidade,
  mensagens, commits gigantes, "wip"/"fix" sem contexto).
- **Descrição de PR** gerada a partir dos commits do branch.

### 4. Leitura de código
- **Tour do projeto:** entry points, módulos, fluxo de dados, onde fica cada coisa.
- **Ordem de leitura guiada:** "para entender X, leia A → B → C".
- **Trace end-to-end:** seguir uma request/evento por todas as camadas.
- **Explicar arquivo/função** com chamadores e chamados (tree-sitter/LSP na fase 3).
- **Hotspots:** churn × tamanho a partir do git (`scripts/hotspots.sh`).
- **Acoplamento temporal:** arquivos que sempre mudam juntos (sinal de abstração errada).
- **Glossário de domínio** extraído do código e mantido em `.project/glossary.md`.
- **Perguntas viram conhecimento:** respostas úteis são propostas para `memory/`.

### 5. Revisão
- **Pre-commit review:** diff → arquitetura → segurança → testes → "pronto para commit?".
- Revisores rodam com **contexto limpo** (subagentes), não no mesmo contexto que escreveu o código.
- **Test gap finder:** código alterado sem teste correspondente.
- Saída sempre como lista priorizada: bloqueante / deveria / opcional.

### 6. Autonomia com worktrees
| Nível | Lê | Modifica | Executa comandos | Onde |
|---|---|---|---|---|
| Manual | pede | pede | pede | branch atual |
| Assisted | auto | pede | pede | branch atual |
| Autonomous | auto | auto | auto (allowlist) | **worktree próprio** |

- Toda tarefa autônoma = `task/<slug>` em `../<repo>.worktrees/<slug>` (`scripts/worktree.sh`).
- Tarefa definida em `.project/tasks/<slug>.md` com critérios de aceite.
- Loop: implementar → testar → corrigir → revisar (subagente) → apresentar diff.
- Várias tarefas em paralelo, uma por worktree.

### 7. Timeline
- Eventos (prompt, tool call, comando, resultado, commit) em SQLite.
- Checkpoint = commit no branch do worktree → voltar = `git reset`/checkout.
- Visão diária: "o que aconteceu hoje" + custo em tokens.

### 8. Extras
- **Daily brief:** o que mudou, tarefas abertas, worktrees pendentes de revisão.
- **Atualização de dependências** em worktree, com testes, um PR por grupo.
- **Benchmarks baseline** em `.project/benchmarks/` e alerta de regressão.
- **Orçamento de tokens** por dia/projeto, com corte automático do modo background.
- **Background agent com gatilhos discretos** (save com debounce, pre-commit, ocioso),
  nunca a cada tecla.

## Fases

| Fase | Entrega | Status |
|---|---|---|
| 0 | Kit com Claude Code: Brain, agentes, skills, hooks, scripts (este repo) | ✅ |
| 1 | Shell Tauri: chat (sidecar SDK), diff, terminal PTY, timeline SQLite | ✅ (empacotar o sidecar no instalador fica para a 2) |
| 2 | Worktree por tarefa na UI, autonomia total em worktree, pipeline de revisão, sidecar no instalador | — |
| 3 | Monaco, LSP, tree-sitter como tools MCP | — |
| 4 | Background agent, daily brief, debugger, embeddings | — |

A Fase 0 existe para descobrir, usando no dia a dia, o que a Fase 1 realmente precisa ter.
