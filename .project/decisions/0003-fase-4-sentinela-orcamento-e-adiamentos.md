# 0003 — Fase 4: Sentinela, orçamento, threads; debugger e embeddings adiados

- Status: aceita
- Data: 2026-10-02

## Contexto

A Fase 4 do roadmap previa agente em background, resumo diário, debugger e embeddings.
A Fase 3 (editor Monaco, LSP, tree-sitter) ainda não foi feita. Ao mesmo tempo, a UI foi
redesenhada em torno de threads (estilo T3 Code), unificando chat e tarefas.

## Decisão

- **Sentinela** (agente em background): gatilho discreto — alterações estáveis + ociosidade
  configurável (padrão 3 min) —, nunca a cada tecla. Revisa só bloqueantes, em modo `plan`,
  esforço `low`, conversa `watch:main` reiniciada a cada execução, sem repetir um diff já
  revisado. **Desligada por padrão**: gasta API, então é opt-in.
- **Orçamento diário** global (todos os projetos), em US$, guardado nas configurações da
  timeline. Ao ser atingido, o Rust recusa conversas `watch:*`; conversas suas continuam.
- **Custo por pedido incremental**: o SDK acumula `total_cost_usd` ao retomar sessões; o
  sidecar desconta o total anterior (e devolve o acumulado para retomar após reiniciar).
- **Resumo do dia** calculado localmente (git + timeline), sem chamar o modelo.
- **Threads** persistidas no `localStorage` do app (metadados, mensagens e sessão do SDK),
  por projeto, retomáveis após reiniciar. Worktrees de tarefa sem thread são adotados.
- **Debugger adiado**: depende de um editor para breakpoints e visualização de código (Fase 3).
  Sem editor, viraria um terminal de gdb/lldb, que o terminal integrado já oferece.
- **Embeddings adiados**: a busca agentic (grep/glob/leitura) já funciona bem; embeddings
  locais exigiriam baixar um modelo (~100 MB) e manter um índice. Revisitar se a busca
  falhar em repositórios grandes.

## Consequências

- ✅ Background útil sem custo surpresa: opt-in, esforço baixo, orçamento com corte no Rust.
- ✅ Fecha o pedido de design: uma única lista de threads para chat e tarefas.
- ❌ `localStorage` não é tão robusto quanto o SQLite; se o volume crescer, migrar as
  threads para a timeline.
- ❌ O roadmap fica com a Fase 3 pendente antes do debugger.
