# Project Brain

Conhecimento durável sobre **como este projeto é construído**, para que o agente
não precise ouvir as mesmas instruções duas vezes.

```text
.project/
├── architecture/   # módulos, fluxos, diagramas (o que é)
├── decisions/      # ADRs numeradas (por que é assim)
├── conventions/    # regras obrigatórias (como fazer)
├── tasks/          # especificações de tarefas autônomas (o que fazer)
├── memory/         # fatos aprendidos em sessões (o que já sabemos)
├── benchmarks/     # baselines de performance
└── glossary.md     # termos de domínio
```

## Regras de manutenção

1. **Curto vence completo.** Um arquivo que ninguém lê apodrece. Prefira listas de regras.
2. **O agente propõe, você aprova.** Nenhuma edição no Brain sem confirmação.
3. **Decisões são imutáveis.** Mudou de ideia? Nova ADR com `Supersedes: 000N`.
4. **Convenção sem exemplo é ambígua.** Toda regra não óbvia leva um ✅/❌.
5. **Carregue sob demanda.** Mexeu em Rust → `conventions/rust.md`. Não tudo sempre.
