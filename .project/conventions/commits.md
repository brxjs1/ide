# Convenção de commits

Baseada em [Conventional Commits](https://www.conventionalcommits.org/). Validada por
`.githooks/commit-msg`.

## Formato

```text
<tipo>(<escopo>)!: <resumo no imperativo, minúsculo, sem ponto, ≤ 72 chars>

<por quê: o problema ou motivação — o diff já mostra o quê>

<o quê / como, se não for óbvio pelo diff>

<como testar, quando relevante>

Refs: <tarefa, issue ou ADR>
BREAKING CHANGE: <descrição, se houver>
```

## Tipos

| Tipo | Quando |
|---|---|
| `feat` | nova capacidade para o usuário |
| `fix` | corrige comportamento errado |
| `refactor` | muda estrutura sem mudar comportamento |
| `perf` | melhora performance sem mudar comportamento |
| `test` | só testes |
| `docs` | só documentação (inclui `.project/`) |
| `build` | build, dependências, empacotamento |
| `ci` | pipelines |
| `chore` | manutenção que não se encaixa acima |
| `style` | formatação pura |
| `revert` | reverte um commit anterior |

`!` após o escopo marca breaking change.

## Escopos

Escopos válidos refletem módulos do projeto. Atualize a lista quando surgir um módulo:

`core`, `desktop`, `ui`, `agent`, `brain`, `git`, `pty`, `lsp`, `index`, `timeline`, `scripts`, `deps`, `ci`

## Estrutura (o que vai em cada commit)

- **Um propósito por commit.** Se o resumo precisa de "e", provavelmente são dois commits.
- **Refactor separado de comportamento.** Primeiro `refactor:`, depois `feat:`/`fix:`.
- **Teste junto do código** que ele testa (mesmo commit), exceto `test:` puro.
- **Cada commit compila e passa nos testes** — mantém `git bisect` útil.
- **Formatação em massa isolada** em `style:` para não poluir o blame.
- **Sem `wip`, `fix`, `ajustes`** como mensagem final. Use `fixup!` e faça squash antes do push.

## Exemplos

✅ `fix(git): ignore submodules ao listar arquivos alterados`
✅ `refactor(pty): extrair leitura de stdout para task própria`
✅ `feat(agent)!: trocar formato de eventos da timeline para JSON lines`

❌ `Fixed bug.` — sem tipo, passado, ponto final, não diz qual bug
❌ `feat: adiciona login e corrige layout do header` — dois propósitos
❌ `update` — não diz nada
