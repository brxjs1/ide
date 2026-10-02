---
name: explain-commits
description: Explica commits e histórico — um SHA, um range, um branch, "o que mudou desde X", "por que esta linha existe", changelog. Use quando o usuário pedir para ler, entender ou resumir commits.
---

# Explicar commits

Delegue ao subagente `commit-historian`, passando o alvo resolvido:

| Pedido do usuário | Alvo |
|---|---|
| "explique o último commit" | `HEAD` |
| "explique abc123" | `abc123` |
| "o que mudou nesse branch" | `$(git merge-base HEAD <branch-padrão>)..HEAD` |
| "o que mudou desde a v1.2" | `v1.2..HEAD` |
| "últimas 2 semanas em src/auth" | `--since="2 weeks ago" -- src/auth` |
| "por que essa linha existe" (arquivo:linha) | `git log -L <l>,<l>:<arquivo>` |
| "changelog" / "release notes" | range + formato Keep a Changelog |
| "como estão meus commits" | auditoria dos últimos 20 |

Descubra o branch padrão com `git symbolic-ref refs/remotes/origin/HEAD` (fallback:
`main`, depois `master`).

Apresente o resultado do subagente sem reescrevê-lo, a menos que seja longo demais —
nesse caso, resuma mantendo SHAs e `arquivo:linha`.
