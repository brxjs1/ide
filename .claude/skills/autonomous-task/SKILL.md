---
name: autonomous-task
description: Executa uma tarefa de forma autônoma em um git worktree isolado — implementa, testa, corrige, revisa e apresenta o diff. Use quando o usuário pedir para implementar algo "sozinho", "em background", "de forma autônoma" ou referenciar um arquivo em .project/tasks/.
---

# Tarefa autônoma em worktree

1. **Especificação.** Se não houver `.project/tasks/<slug>.md`, crie a partir de
   `.project/tasks/TEMPLATE.md` com o usuário: objetivo, critérios de aceite,
   fora de escopo, comandos de verificação. Confirme antes de seguir.
2. **Isolamento.** `scripts/worktree.sh new <slug>` e trabalhe **somente** no caminho
   impresso. Nunca altere o worktree principal.
3. **Loop** (máx. 5 iterações sem progresso):
   - implementar o próximo critério;
   - rodar os comandos de verificação;
   - falhou → diagnosticar a causa raiz e corrigir (nunca desabilitar teste);
   - passou → commit atômico no padrão `.project/conventions/commits.md`.
4. **Revisão.** Com todos os critérios cumpridos, rode o subagente `reviewer` sobre
   `git diff <base>...task/<slug>`. Corrija 🔴 e repita.
5. **Entrega:**

```text
Tarefa: <slug>  Branch: task/<slug>  Worktree: <caminho>
Critérios: [x] ... [x] ...
Verificação: <comandos> → passou
Commits: <git log --oneline base..task/<slug>>
Revisão: <veredito + 🟡 restantes>
Próximo passo: revisar com `scripts/worktree.sh diff <slug>`; integrar com merge.
```

Se travar (requisito ambíguo, dependência externa, mesma falha 3 vezes), pare e
pergunte — com o que tentou e o que precisa.
Nunca faça push, merge no branch principal ou apague o worktree sem pedido explícito.
