# 0002 — Autonomia total só em worktree de tarefa

- Status: aceita
- Data: 2026-10-02

## Contexto

A Fase 2 permite que o agente trabalhe sem pedir aprovação (tarefas longas) e que uma
revisão rode testes sozinha. Sem limites, isso daria ao agente escrita e execução livres
no branch em que o usuário está trabalhando.

## Decisão

- Dois modos sem aprovação: `full` (edita e executa) e `review` (executa, mas as
  ferramentas de edição são removidas via `disallowedTools`).
- Ambos só são aceitos com `cwd` dentro de um **worktree de tarefa**: branch `task/*`
  em um worktree que não é o principal. A checagem fica no Rust
  (`ide_core::tasks::is_task_worktree`, chamada em `agent_send`), não na UI nem no
  sidecar — a UI só deixa de oferecer o modo.
- Estado da tarefa vive no git: objetivo em `branch.task/<slug>.description` e base em
  `branch.task/<slug>.idebase`. Apagar o branch apaga o estado.
- Integrar exige worktrees limpos e usa `merge --no-ff`; em conflito, `merge --abort`
  e nada muda no branch principal.

## Alternativas consideradas

- Checar o modo só na UI — qualquer bug ou chamada direta ao comando furaria a regra.
- Guardar tarefas no SQLite — duplicaria o que o git já sabe e poderia divergir dele.
- Sandbox de sistema operacional — mais forte, mas fica para depois; o worktree já
  isola o branch do usuário, que é o risco principal.

## Consequências

- ✅ O pior caso de uma tarefa é um branch descartável.
- ✅ `git branch --edit-description` e `scripts/worktree.sh` continuam compatíveis.
- ❌ `full` ainda pode afetar o resto do sistema via comandos (rede, arquivos fora do
  worktree). O prompt da tarefa pede para não sair do diretório, mas isso não é
  garantia — um sandbox de SO é o próximo passo de segurança.
