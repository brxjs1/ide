---
name: analyze-project
description: Análise completa do projeto — arquitetura, dependências, histórico git, testes, segurança, performance — e um plano priorizado de melhorias. Use quando o usuário pedir "analise o projeto" ou "o que precisa melhorar".
---

# Analisar projeto

Rode as frentes em paralelo (subagentes) e consolide:

| Frente | Como |
|---|---|
| Arquitetura | `code-reader` em modo tour; compare com `.project/architecture/` e ADRs |
| Histórico | `commit-historian`: hotspots, acoplamento temporal, auditoria de commits |
| Dependências | manifests (Cargo.toml, package.json...): desatualizadas, duplicadas, sem uso |
| Testes | rodar suíte; módulos sem teste; testes lentos ou instáveis |
| Segurança | `security-reviewer` sobre os hotspots e pontos de I/O |
| Performance | caminhos quentes, alocações em loop, I/O síncrono; baselines em `.project/benchmarks/` |

Saída:

```text
## Diagnóstico (5 linhas)

## Plano priorizado
| # | Item | Impacto | Esforço | Risco | Autônomo? |
|---|------|---------|---------|-------|-----------|

## Pode ser feito automaticamente agora
<itens com testes cobrindo e risco baixo — cada um vira .project/tasks/<slug>.md>

## Precisa da sua decisão
<itens que exigem escolha de arquitetura → proposta de ADR>
```

"Autônomo? sim" só quando: escopo local, testes existentes cobrem a área e não há
decisão de design envolvida. Não implemente nada nesta skill.
