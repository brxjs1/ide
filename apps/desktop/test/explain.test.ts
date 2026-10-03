import assert from "node:assert/strict";
import { test } from "node:test";

import { explain, explainedCodes } from "../src/lib/explain.ts";

test("TS2322 usa os tipos da mensagem", () => {
  const e = explain({ code: "2322", source: "typescript", message: "Type 'string' is not assignable to type 'number'." });
  assert.ok(e);
  assert.equal(e.code, "TS2322");
  assert.equal(e.title, "Tipo string não cabe em number");
  assert.match(e.summary, /`string` onde o código espera `number`/);
  assert.ok(e.fixes.some((f) => f.includes("`number`")));
  assert.ok(e.example);
});

test("argumentos, propriedades e sugestões", () => {
  assert.equal(
    explain({ code: "2554", message: "Expected 2 arguments, but got 1." })?.title,
    "Esperava 2 argumento(s), recebeu 1",
  );
  assert.equal(
    explain({ code: "2339", message: "Property 'nomee' does not exist on type 'Usuario'." })?.title,
    "Usuario não tem a propriedade nomee",
  );
  assert.equal(
    explain({ code: "2551", message: "Property 'lenght' does not exist on type 'string[]'. Did you mean 'length'?" })?.fixes[0],
    "Troque por `length`.",
  );
  assert.equal(explain({ code: "18048", message: "'item' is possibly 'undefined'." })?.title, "item pode ser undefined");
});

test("aceita o código com prefixo TS e ignora o desconhecido", () => {
  assert.equal(explain({ code: "TS7006", message: "Parameter 'x' implicitly has an 'any' type." })?.title, "Parâmetro x sem tipo");
  assert.equal(explain({ code: "99999", message: "algo" }), null);
  assert.equal(explain({ code: null, message: "sem código" }), null);
});

test("erros do Rust pelo código ou pela fonte", () => {
  const e = explain({ code: "E0308", source: "rustc", message: "mismatched types\nexpected `String`, found `i64`" });
  assert.equal(e?.title, "Esperava String, recebeu i64");
  assert.equal(explain({ code: "E0384", message: "cannot assign twice to immutable variable `x`" })?.fixes[0], "Declare como `let mut x`.");
  // Sem trechos citados, o texto continua legível.
  assert.equal(explain({ code: "E0308", message: "mismatched types" })?.title, "Tipos incompatíveis");
});

test("cobertura: dezenas de erros do TypeScript", () => {
  const { typescript, rust } = explainedCodes();
  assert.ok(typescript.length >= 45, `só ${typescript.length}`);
  assert.ok(rust.length >= 12);
  // Toda entrada gera textos não vazios mesmo sem argumentos na mensagem.
  for (const code of typescript) {
    const e = explain({ code, message: "" })!;
    assert.ok(e.title && e.summary && e.why && e.fixes.length, code);
  }
});
