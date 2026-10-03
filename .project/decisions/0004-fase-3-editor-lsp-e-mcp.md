# 0004 — Fase 3: editor Monaco, LSP no Rust e ferramentas MCP para o agente

- Status: aceita
- Data: 2026-10-02

## Contexto

A Fase 3 do roadmap pede Monaco, LSP e tree-sitter expostos ao agente como ferramentas
MCP. O agente já lê e edita arquivos pelo SDK, mas não tem visão de estrutura (outline,
símbolos) nem dos erros do compilador sem rodar o build inteiro. A UI não tinha editor.

## Decisão

- **Uma implementação, dois clientes.** tree-sitter (`crates/syntax`) e o cliente LSP
  (`crates/lsp`) vivem no Rust e servem tanto o editor da UI (comandos Tauri finos em
  `src-tauri/src/editor.rs`) quanto o agente (`crates/mcp`).
- **MCP como binário stdio separado (`ide-mcp --root <dir>`)**, e não um servidor dentro
  do processo do app: o SDK sobe servidores MCP stdio sozinho, com o `cwd` certo
  (inclusive worktrees). Hoje é um processo por pedido (cada `query()` sobe o seu). O Rust informa o caminho ao sidecar por `IDE_MCP_COMMAND`;
  sem a variável, o agente roda sem as ferramentas. No instalador, `ide-mcp` vai como
  `externalBin`.
- **Ferramentas que não editam nada**, em dois grupos:
  - `outline_file`, `find_symbol`, `project_tree` (tree-sitter, só leem arquivos) são
    aprovadas de antemão em `allowedTools`;
  - `diagnostics` e `definition` sobem o servidor de linguagem, que **executa código do
    projeto** (`build.rs`, proc-macros e `cargo check` no rust-analyzer; o `tsserver` do
    `node_modules`). Passam pela aprovação como um comando e ficam fora do modo `plan`.
    Num repositório não confiável, uma prompt injection não as dispara sem você ver.
- **Servidores de linguagem do PATH** (rust-analyzer, typescript-language-server, pyright,
  gopls). Ausente → o editor e a ferramenta dizem "indisponível"; nada é baixado.
- **Sincronização completa** (`didChange` com o texto inteiro) e **`didSave` ao salvar**:
  o rust-analyzer só roda o `cargo check` no save; sem isso os erros não somem.
- **Segurança de caminhos** em `ide_core::files::resolve`: caminhos relativos, sem `..`,
  sem symlink que saia da raiz. Escrita atômica com temporário de nome único criado com
  `create_new` (nunca escreve através de um symlink plantado), mantendo as permissões do
  original e gravando no alvo de symlinks internos. Limite de 2 MB e recusa de binários;
  a busca de símbolos ignora symlinks.
- **Servidor que morre é substituído** no próximo uso; o `LspManager` guarda os documentos
  abertos pelo editor, reabre-os no servidor novo e descarta versões fora de ordem.
- **Monaco** com workers locais (Vite `?worker`) e diagnósticos próprios do TypeScript
  desligados: a fonte de verdade é o servidor de linguagem, igual ao que o agente vê.
- **Ícone novo** do app (chevrons de código + faísca), gerado com `tauri icon` a partir
  de um SVG; Android/iOS fora do repositório.

## Consequências

- ✅ O agente navega por estrutura e vê erros reais sem ler arquivos inteiros nem rodar build.
- ✅ Editor e agente enxergam os mesmos diagnósticos.
- ✅ Funciona em worktrees de tarefa sem configuração extra (o `--root` é o `cwd`).
- ❌ Cada pedido ao agente sobe seu próprio `ide-mcp` e, se usar `diagnostics`/`definition`,
  um servidor de linguagem frio (que disputa o lock do `target/` com o do editor). Em
  projeto grande a primeira chamada pode responder "indexando". Próximo passo: um
  `ide-mcp` por conversa (transporte HTTP/SSE ou servidor MCP no processo do sidecar).
- ❌ Os comandos `file_*`/`lsp_*` aceitam a raiz que a UI mandar (como `pty_spawn`); a
  fronteira é o próprio webview (CSP `default-src 'self'`). Restringir às raízes abertas
  fica como defesa em profundidade futura.
- ❌ Sem autocompletar via LSP nem rename ainda — hover, definição e diagnósticos primeiro.
- ❌ Debugger (ADR 0003) continua adiado; agora há editor para apoiá-lo.
