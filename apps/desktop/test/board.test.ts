import assert from "node:assert/strict";
import { test } from "node:test";

import { taskBody } from "../src/lib/board.ts";

test("o corpo da tarefa começa na primeira seção, sem título nem metadados", () => {
  const md = "# Validar CPF\r\n\r\n- Status: a fazer\r\n- Worktree: task/x\r\n\r\n## Objetivo\r\n\r\nValidar.\r\n\r\n## Critérios de aceite\r\n\r\n- [ ] testes\r\n";
  assert.equal(taskBody(md), "## Objetivo\n\nValidar.\n\n## Critérios de aceite\n\n- [ ] testes");
});

test("sem seções, devolve o texto livre sem título e metadados", () => {
  assert.equal(taskBody("# T\n- Status: a fazer\n\nFazer a coisa."), "Fazer a coisa.");
  assert.equal(taskBody("# T\n- Status: a fazer\n"), "");
});

test("corpo longo é cortado", () => {
  const body = taskBody(`## Notas\n${"x".repeat(20_000)}`);
  assert.ok(body.length < 12_100 && body.endsWith("[…]"));
});
