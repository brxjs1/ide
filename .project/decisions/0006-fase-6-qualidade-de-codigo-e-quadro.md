# 0006 — Fase 6: qualidade de código (SonarLint como referência), Error Lens, explicador de erros e quadro de tarefas

- Status: aceita
- Data: 2026-10-03

## Contexto

O editor já mostrava os diagnósticos do servidor de linguagem, mas só como sublinhado e
na mensagem crua do compilador (em inglês). Faltava o que o SonarLint dá no dia a dia:
problemas de qualidade além dos erros de tipo, com "por que" e "como corrigir". Faltava
também um lugar para guardar o que está a fazer, em progresso e concluído, que o agente
pudesse ler.

## Decisão

- **Analisador próprio em Rust (`crates/lint`) sobre o tree-sitter**, e não o SonarLint
  em si: o SonarLint precisa de Java e de um servidor de linguagem próprio. Isso
  quebraria o "local, sem dependências pesadas" (ADR 0001). As **chaves das regras são
  as do SonarJS**, como referência. Os textos (por que, como corrigir, exemplos) são
  nossos, em português. São 26 regras para JS/TS (bugs, vulnerabilidades, pontos de
  segurança e code smells), com complexidade cognitiva pela especificação do Sonar, e
  2 para qualquer linguagem (TODO e FIXME).
- **Taxonomia e notas no estilo Sonar**:
  - tipo (bug, vulnerabilidade, ponto de segurança, code smell);
  - severidade (bloqueante → info);
  - dívida estimada por regra;
  - notas A–E: manutenibilidade pela razão de dívida; confiabilidade e segurança pelo
    problema mais grave.
- **Falsos positivos tratados na regra, não no usuário**:
  - credenciais: nomes de senha contam se o valor parece senha (sem espaço, com dígito
    ou símbolo, diferente do nome; `senha: "Senha"` é rótulo de interface);
    `token`/`secret` só com valor de cara de segredo;
  - `switch` só com strings em TS fica de fora (união discriminada, que o compilador
    verifica);
  - `== null` e `== undefined` são idiomáticos;
  - supressão com `NOSONAR` ou `ide-lint-disable-next-line [regra]`.
- **Correções automáticas** (Ctrl+.) só onde a troca não muda o significado:
  - `==`→`===` (a única com risco: muda o resultado quando os tipos diferem; é o que a
    regra pede, e o diff fica visível);
  - `var`→`let` só para declaração direto no corpo de uma função, sem uso antes nem
    redeclaração (fora disso, o escopo de bloco quebraria o código);
  - remover `debugger`, `console.log` e `;` extra só dentro de bloco: como corpo de
    `if`/laço sem chaves, a linha seguinte viraria o corpo;
  - `any` não tem correção: `unknown` exige checagens em cada uso;
  - "Ignorar nesta linha" em todas, menos quando a linha começa dentro de string,
    template ou JSX (o comentário viraria conteúdo);
  - a correção vale para a versão do texto analisada; editou depois, espera a próxima
    análise.
- **Análise ao vivo no editor** (texto atual, antes de salvar, com debounce) e do
  projeto inteiro (painel Problemas, a cada mudança no git). A cor vermelha fica com o
  compilador; qualidade aparece como aviso ou informação.
- **Error Lens próprio**: a mensagem mais grave da linha aparece no fim dela, com a linha
  tingida pela severidade (texto injetado do Monaco). Para erros conhecidos do
  compilador, mostra a frase do explicador em vez da mensagem crua. Pode ser ligado ou
  desligado, e mostrar tudo, só erros e avisos, ou só erros.
- **Gerador de explicações** (`lib/explain.ts`) para 49 erros do TypeScript e 13
  do Rust:
  - o servidor de linguagem agora repassa o código do erro (`2322`, `E0308`);
  - os nomes e tipos são extraídos da mensagem;
  - em português: o que aconteceu, por que, como resolver e um exemplo;
  - aparece no hover, no Error Lens e no painel.
- **Quadro de tarefas em `.project/tasks/<slug>.md`** (o mesmo lugar das especificações
  do Brain), com `- Status: a fazer | em progresso | concluída`, prioridade, worktree e
  checklist (vira barra de progresso).
  - **Formato:** os arquivos continuam editáveis à mão e versionados, e o agente lê o
    quadro pela ferramenta `task_board`.
  - **Executar com o agente:** cria o worktree e marca a tarefa em progresso. O
    objetivo e os critérios vão no pedido: o arquivo costuma não estar commitado e,
    então, não existe no worktree. O agente não edita o arquivo da tarefa; quem muda o
    status é o app.
  - **Integrar:** conclui a tarefa. **Descartar** a devolve para a fazer. Os dois
    limpam o `- Worktree:`.
  - **Integrar com quadro alterado:** mudanças só em `.project/tasks/` não bloqueiam o
    Integrar, porque o app as faz no checkout enquanto a tarefa roda. Se o branch
    também mudou um desses arquivos, o Integrar recusa antes do merge e diz quais.
- **Ferramentas MCP `code_issues` e `task_board`**, pré-aprovadas: só leem arquivos, sem
  executar código do projeto (diferente das de LSP, ADR 0004).
- **Botões e tooltips**:
  - botões com gradiente sutil, brilho interno e anel de foco;
  - grupo segmentado para Revisar · Integrar · Descartar;
  - perigo suave até a confirmação;
  - tooltips próprias (`data-tip`) de vidro e com atraso, no lugar do `title` nativo.

## Consequências

- ✅ Qualidade e erros explicados sem sair do editor nem instalar nada além do servidor
  de linguagem.
- ✅ O agente vê os mesmos problemas e o mesmo quadro que você.
- ❌ As regras são aproximações sintáticas, sem a análise de tipos e fluxo de dados do
  SonarJS. Vão ter falsos positivos e negativos que o Sonar não tem. Novas regras
  precisam de teste com código real (fizemos com o próprio app).
- ❌ Explicações só para os códigos mapeados; os demais mostram a mensagem original.
- ❌ O quadro não tem histórico próprio: o histórico é o do git.
