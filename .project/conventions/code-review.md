# Convenção de revisão

Toda revisão (humana ou de agente) produz achados classificados:

| Nível | Significado | Bloqueia commit? |
|---|---|---|
| 🔴 bloqueante | bug, falha de segurança, quebra de contrato, teste faltando para lógica nova | sim |
| 🟡 deveria | manutenção, nome ruim, duplicação, convenção violada | não, mas registre |
| ⚪ opcional | preferência, nit | não |

## O que sempre verificar

1. **Correção:** casos de borda, erros ignorados, concorrência, off-by-one.
2. **Segurança:** input não validado, path traversal, comando shell montado com string,
   segredo em código ou log, permissão excessiva.
3. **Testes:** lógica nova ou alterada tem teste? O teste falharia sem a mudança?
4. **Arquitetura:** respeita `.project/decisions/` e `.project/architecture/`?
5. **Convenções:** `.project/conventions/*`.
6. **Commit:** a mudança está bem dividida? (ver `commits.md`)

## Formato de saída

```text
Veredito: PRONTO | PRONTO COM RESSALVAS | NÃO PRONTO

🔴 arquivo:linha — problema — sugestão
🟡 arquivo:linha — problema — sugestão
⚪ arquivo:linha — problema — sugestão
```

Não liste elogios nem resumos do diff. Só achados acionáveis.
