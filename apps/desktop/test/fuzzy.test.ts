import assert from "node:assert/strict";
import { test } from "node:test";

import { fuzzyFilter, fuzzyScore } from "../src/lib/fuzzy.ts";

const PATHS = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/styles.css",
  "apps/desktop/src/components/EditorView.tsx",
  "apps/desktop/src/components/CommandPalette.tsx",
  "apps/desktop/src/lib/fuzzy.ts",
  "crates/core/src/files.rs",
  "src/conta.rs",
  "src/lib.rs",
];
const ACTIONS = ["Nova thread", "Abrir arquivo…", "Ir para o editor", "Mostrar terminal", "Painel: Hoje"];

const first = (items: string[], q: string) => fuzzyFilter(items, q, (s) => s)[0];

test("letras precisam aparecer em ordem", () => {
  assert.equal(fuzzyScore("xyz", "Nova thread"), null);
  assert.equal(fuzzyScore("adn", "Nova"), null);
  assert.notEqual(fuzzyScore("nt", "Nova thread"), null);
  assert.equal(fuzzyScore("", "qualquer"), 0);
});

test("iniciais e camelCase acham o arquivo", () => {
  assert.equal(first(PATHS, "cp"), "apps/desktop/src/components/CommandPalette.tsx");
  assert.equal(first(PATHS, "ev"), "apps/desktop/src/components/EditorView.tsx");
  assert.equal(first(ACTIONS, "nt"), "Nova thread");
});

test("o nome do arquivo vale mais que as pastas", () => {
  assert.equal(first(PATHS, "app"), "apps/desktop/src/App.tsx");
  assert.equal(first(PATHS, "lib"), "src/lib.rs");
  assert.equal(first(PATHS, "conta"), "src/conta.rs");
  assert.equal(first(PATHS, "files"), "crates/core/src/files.rs");
});

test("casamentos espalhados são cortados", () => {
  // "soma" aparece solta em "Mostrar terminal" (s…o…m…a), sem fronteira nem sequência.
  assert.deepEqual(fuzzyFilter(["Mostrar terminal"], "soma", (s) => s), []);
  assert.deepEqual(fuzzyFilter(["Criar testes para soma"], "soma", (s) => s), ["Criar testes para soma"]);
});

test("sem consulta, mantém a ordem e o limite", () => {
  assert.deepEqual(fuzzyFilter(ACTIONS, "  ", (s) => s, 2), ["Nova thread", "Abrir arquivo…"]);
});
