---
name: review-before-commit
description: Pipeline de revisão antes de commitar — estrutura do commit, revisão geral, segurança, testes e veredito "pronto para commit?". Use quando o usuário pedir para revisar antes de commitar ou antes de propor um commit.
---

# Revisão antes do commit

1. **Escopo do diff.** `git diff --staged --stat`. Se nada estiver staged, use
   `git diff HEAD --stat` e avise que está revisando o working tree.
2. **Estrutura.** O diff tem um único propósito? Se misturar refactor com
   comportamento, ou duas features, pare e sugira usar a skill `structure-commits`.
3. **Revisão geral.** Delegue ao subagente `reviewer`.
4. **Segurança.** Se o diff tocar processos, filesystem, rede, auth, IPC, tools MCP
   ou dependências, delegue também ao `security-reviewer` (em paralelo com o passo 3).
5. **Testes.** Descubra o comando de teste do projeto (Cargo.toml, package.json,
   Makefile, `.project/tasks/*`) e rode. Liste funções/arquivos alterados sem teste
   correspondente.
6. **Veredito consolidado:**

```text
Pronto para commit? SIM | SIM, COM RESSALVAS | NÃO

Estrutura: <ok | dividir em N commits: ...>
Testes:    <comando> → <passou/falhou> ; lacunas: ...
🔴 ...
🟡 ...
⚪ ...

Mensagem sugerida:
<tipo>(<escopo>): <resumo>

<corpo>
```

Nunca execute `git commit` nesta skill — apenas proponha.
