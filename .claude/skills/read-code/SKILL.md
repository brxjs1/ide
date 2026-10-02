---
name: read-code
description: Ajuda a ler e entender código — tour do projeto, ordem de leitura, trace de fluxo, explicar arquivo/função, hotspots. Use quando o usuário quer entender código existente sem modificá-lo.
---

# Ler código

1. Identifique o modo: **tour**, **trace**, **explicar**, **ordem de leitura** ou **hotspots**.
2. Leia `.project/architecture/` e `.project/glossary.md` primeiro — se já explicam
   a pergunta, comece por eles e só complemente.
3. Para hotspots, rode `scripts/hotspots.sh` e combine com o tamanho dos arquivos.
4. Para os demais modos, delegue ao subagente `code-reader` com o alvo e o objetivo.
5. Depois da resposta, se o usuário aprendeu algo durável (um fluxo, um termo, uma
   armadilha), proponha a atualização exata em `.project/architecture/`,
   `.project/glossary.md` ou `.project/memory/`. Não edite sem aprovação.
