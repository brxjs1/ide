# ide — AI Development OS pessoal

Ambiente de desenvolvimento sob medida, local-first, construído em volta de um agente.
Visão completa e fases em [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Fase 0 — usar hoje com Claude Code

```bash
scripts/install-hooks.sh
```

Copie `CLAUDE.md`, `.project/`, `.claude/`, `.githooks/` e `scripts/` para qualquer
projeto seu para levar o kit junto.

### O que pedir ao agente

| Você diz | O que acontece |
|---|---|
| "analise esse projeto e diga o que melhorar" | skill `analyze-project` → plano priorizado |
| "revise antes de eu commitar" | skill `review-before-commit` → estrutura, revisão, segurança, testes, veredito |
| "organize essas mudanças em commits" | skill `structure-commits` → plano de commits atômicos |
| "explique o último commit" / "o que mudou nesse branch" | skill `explain-commits` |
| "por que essa linha existe?" (arquivo:linha) | `commit-historian` via `git log -L` |
| "como estão meus commits?" | auditoria com nota e exemplos |
| "me dá um tour do projeto" / "trace o fluxo de X" | skill `read-code` → `code-reader` |
| "implemente X sozinho" | skill `autonomous-task` → worktree isolado, testes, revisão, diff |

### Peças

| Caminho | Papel |
|---|---|
| `.project/` | Project Brain: arquitetura, ADRs, convenções, tarefas, memória, glossário |
| `.claude/agents/` | subagentes: `reviewer`, `security-reviewer`, `code-reader`, `commit-historian` |
| `.claude/skills/` | fluxos: análise, revisão, commits, leitura de código, tarefa autônoma |
| `.githooks/commit-msg` | valida Conventional Commits |
| `scripts/worktree.sh` | `new` / `list` / `diff` / `log` / `rm` de worktrees de tarefa |
| `scripts/hotspots.sh` | hotspots (churn × tamanho) e acoplamento temporal |
