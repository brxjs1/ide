# Benchmarks

Baselines de performance, um arquivo por cenário:

```text
<cenario>.md
- comando: <como medir>
- máquina: <cpu/ram/os>
- baseline: <valor> (commit <sha>, data)
- tolerância: <ex.: +10%>
```

O agente compara contra a baseline em tarefas `perf:` e em revisões que tocam código quente.
