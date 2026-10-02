import assert from "node:assert/strict";
import { test } from "node:test";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Outbound } from "../src/protocol.ts";
import { AgentServer, type QueryFn, permissionModeFor } from "../src/server.ts";

// Mensagens do SDK reduzidas ao que o servidor lê.
const init = { type: "system", subtype: "init", model: "m", cwd: "/p", permissionMode: "default", session_id: "s1" };
const assistant = (content: unknown[]) => ({
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s1",
  message: { content },
});
const toolResult = {
  type: "user",
  parent_tool_use_id: null,
  session_id: "s1",
  message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
};
const result = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 5, result: "fim", session_id: "s1" };

type Script = (options: Options) => AsyncGenerator<unknown>;

/** Chama o canUseTool como o SDK faria e devolve só a decisão. */
async function ask(options: Options, toolName: string): Promise<string> {
  const signal = new AbortController().signal;
  const decision = await options.canUseTool!(toolName, {}, { signal, toolUseID: toolName, requestId: "r" });
  return decision?.behavior ?? "sem decisão";
}

function fakeQuery(script: Script, calls: Options[] = []): QueryFn {
  return (({ options }: { options: Options }) => {
    calls.push(options);
    const gen = script(options) as AsyncGenerator<SDKMessage> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => {
      await gen.return(undefined);
    };
    return gen;
  }) as unknown as QueryFn;
}

function collect() {
  const out: Outbound[] = [];
  return { out, send: (m: Outbound) => out.push(m) };
}

test("converte mensagens do SDK em eventos e conclui com done", async () => {
  const { out, send } = collect();
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield init;
      yield assistant([
        { type: "text", text: "Vou ler." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
      ]);
      yield toolResult;
      yield result;
    }),
    send,
  );

  await server.handle({ type: "prompt", id: "p1", text: "oi", cwd: "/p", mode: "assisted" });

  assert.deepEqual(
    out.map((m) => (m.type === "event" ? m.event.kind : m.type)),
    ["init", "text", "tool_use", "tool_result", "done"],
  );
  const toolRes = out.find((m) => m.type === "event" && m.event.kind === "tool_result");
  assert.deepEqual(toolRes, {
    type: "event",
    promptId: "p1",
    event: { kind: "tool_result", toolUseId: "t1", isError: false, content: "ok" },
  });
  assert.deepEqual(out.at(-1), {
    type: "done",
    promptId: "p1",
    sessionId: "s1",
    isError: false,
    costUsd: 0.01,
    durationMs: 5,
    result: "fim",
  });
  assert.equal(server.busy, false);
});

test("retoma a sessão no pedido seguinte e esquece após reset", async () => {
  const calls: Options[] = [];
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield init;
      yield result;
    }, calls),
    () => {},
  );
  const prompt = (id: string) => server.handle({ type: "prompt", id, text: "x", cwd: "/p", mode: "plan" });

  await prompt("p1");
  await prompt("p2");
  await server.handle({ type: "reset" });
  await prompt("p3");

  assert.deepEqual(
    calls.map((o) => o.resume),
    [undefined, "s1", undefined],
  );
  assert.equal(calls[0]?.permissionMode, "plan");
});

test("pede permissão à UI e respeita a resposta", async () => {
  const { out, send } = collect();
  const decisions: string[] = [];
  const server = new AgentServer(
    fakeQuery(async function* (options) {
      for (const tool of ["Bash", "Edit"]) {
        decisions.push(`${tool}:${await ask(options, tool)}`);
      }
      yield result;
    }),
    (msg) => {
      send(msg);
      if (msg.type === "permission_request") {
        // Responde fora do fluxo atual, como a UI faria.
        const allow = msg.toolName === "Bash";
        queueMicrotask(() => void server.handle({ type: "permission_response", id: msg.id, allow }));
      }
    },
  );

  await server.handle({ type: "prompt", id: "p1", text: "x", cwd: "/p", mode: "assisted" });

  assert.deepEqual(decisions, ["Bash:allow", "Edit:deny"]);
  assert.equal(out.filter((m) => m.type === "permission_request").length, 2);
});

test("interromper nega permissões pendentes e encerra a execução", async () => {
  const { out, send } = collect();
  let decision = "";
  const server = new AgentServer(
    fakeQuery(async function* (options) {
      decision = await ask(options, "Bash");
      yield result;
    }),
    (msg) => {
      send(msg);
      if (msg.type === "permission_request") queueMicrotask(() => void server.handle({ type: "interrupt" }));
    },
  );

  await server.handle({ type: "prompt", id: "p1", text: "x", cwd: "/p", mode: "assisted" });

  assert.equal(decision, "deny");
  assert.equal(server.busy, false);
  assert.equal(out.at(-1)?.type, "done");
});

test("rejeita um segundo pedido enquanto ocupado", async () => {
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = new AgentServer(
    fakeQuery(async function* () {
      await gate;
      yield result;
    }),
    send,
  );

  const first = server.handle({ type: "prompt", id: "p1", text: "x", cwd: "/p", mode: "plan" });
  await server.handle({ type: "prompt", id: "p2", text: "y", cwd: "/p", mode: "plan" });
  release();
  await first;

  assert.deepEqual(out[0], { type: "error", promptId: "p2", message: "o agente já está executando um pedido" });
});

test("erro do SDK vira error + done com isError", async () => {
  const { out, send } = collect();
  const server = new AgentServer(
    fakeQuery(async function* () {
      throw new Error("sem credenciais");
    }),
    send,
  );

  await server.handle({ type: "prompt", id: "p1", text: "x", cwd: "/p", mode: "plan" });

  assert.deepEqual(out[0], { type: "error", promptId: "p1", message: "sem credenciais" });
  assert.equal(out[1]?.type, "done");
  assert.equal(out[1]?.type === "done" && out[1].isError, true);
});

test("mapeia autonomia para modo de permissão do SDK", () => {
  assert.equal(permissionModeFor("plan"), "plan");
  assert.equal(permissionModeFor("assisted"), "default");
  assert.equal(permissionModeFor("autonomous"), "acceptEdits");
});
