# 0005 — Fase 5: interface preta moderna (referência T3 Code) e paleta de comandos

- Status: aceita
- Data: 2026-10-03

## Contexto

O roadmap terminava na Fase 4; a interface já seguia o T3 Code em estrutura (threads,
composer, painel), mas com cinzas próprios, cartões elevados e só navegação por mouse.
Pedido: um "preto moderno" e modernidade no layout todo, lendo o próprio T3 Code
(`pingdotgg/t3code`, app web em React + Tailwind 4).

## Decisão

- **Tokens copiados do tema escuro do T3 Code** (`apps/web/src/index.css`), em CSS puro:
  corpo e barra lateral `#000`; área principal `#0a0a0a` (neutral-950); bordas e estados
  por transparência de branco (borda 8%, hover 6%, ativo 9%) em vez de cinzas sólidos;
  azul primário `oklch(0.571 0.21 264)` ≈ `#346bf1`; fontes do sistema.
- **Card principal "inset"**: área principal e painel lateral flutuam sobre o corpo preto
  com 8px de respiro, cantos de 12px e textura grain (SVG `feTurbulence`, 3,5%) — como o
  `SidebarInset` do T3.
- **Vidro só em superfícies flutuantes** (composer, avisos, paleta): fundo translúcido +
  `backdrop-filter`. A opacidade fica alta (92–96%) porque o WebKitGTK sem composição
  ignora o blur; sem ele o texto de trás não pode competir.
- **Componentes no idioma do T3**: linhas de thread sem cartão; abas em pílula; botões
  "outline" com brilho interno de 1px; bolha só na mensagem do usuário; ferramentas como
  linhas de um registro de trabalho (sem caixa); texto "trabalhando" com brilho animado;
  composer de 22px com a faixa de contexto presa por baixo; barra de 52px.
- **Movimento contido**: `cubic-bezier(0.32, 0.72, 0, 1)` para o que entra (painel,
  terminal, mensagens, paleta); `prefers-reduced-motion` desliga tudo.
- **Paleta de comandos** (`Ctrl+K`; `Ctrl+P` só arquivos) com busca aproximada local
  (`lib/fuzzy.ts`: letras em ordem, bônus para início de palavra e sequência, corte de
  casamentos espalhados). Atalhos globais em captura (`Ctrl+N` nova thread, `Ctrl+B`
  barra lateral, `Ctrl+J` terminal), antes do Monaco. Com o foco no terminal eles não
  valem: lá essas teclas são do readline do shell (cursor, histórico, apagar linha).
- **Layout responsivo ao painel**: com a área principal estreita, os botões da barra viram
  só ícone (container query) e o editor esconde a estrutura. A estrutura é decidida em JS
  (`ResizeObserver`): mudança vinda de container query não reacende o layout do Monaco
  no WebKitGTK.

## Consequências

- ✅ Visual coeso com a referência: preto profundo, hierarquia por bordas sutis, foco no
  conteúdo; Monaco e terminal no mesmo preto.
- ✅ Tudo alcançável pelo teclado; abrir arquivo ou trocar de thread sem mouse.
- ❌ `Ctrl+K` substitui os acordes `Ctrl+K …` do Monaco (comentar continua em `Ctrl+/`).
- ❌ Só tema escuro (como antes). Um tema claro exigiria duplicar os tokens.
- ❌ Sem Tailwind: os valores do T3 foram traduzidos à mão; mudanças futuras lá não chegam
  sozinhas.
