import assert from "node:assert/strict";
import { test } from "node:test";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AutonomyMode, Outbound } from "../src/protocol.ts";
import {
  AgentServer,
  IDE_LSP_TOOLS,
  IDE_READ_TOOLS,
  type QueryFn,
  ideMcp,
  incrementalCost,
  permissionModeFor,
} from "../src/server.ts";

// Mensagens do SDK reduzidas ao que o servidor lê.
const init = (session = "s1") => ({
  type: "system",
  subtype: "init",
  model: "m",
  cwd: "/p",
  permissionMode: "default",
  session_id: session,
});
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
const result = (session = "s1") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.01,
  duration_ms: 5,
  result: "fim",
  session_id: session,
});

type Script = (options: Options) => AsyncGenerator<unknown>;

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

/** Chama o canUseTool como o SDK faria e devolve só a decisão. */
async function ask(options: Options, toolName: string): Promise<string> {
  const signal = new AbortController().signal;
  const decision = await options.canUseTool!(toolName, {}, { signal, toolUseID: toolName, requestId: "r" });
  return decision?.behavior ?? "sem decisão";
}

function collect() {
  const out: Outbound[] = [];
  return { out, send: (m: Outbound) => out.push(m) };
}

const prompt = (server: AgentServer, id: string, conversation = "main", mode: AutonomyMode = "assisted") =>
  server.handle({ type: "prompt", conversation, id, text: "x", cwd: "/p", mode });

test("converte mensagens do SDK em eventos e conclui com done", async () => {
  const { out, send } = collect();
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield init();
      yield assistant([
        { type: "text", text: "Vou ler." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
      ]);
      yield toolResult;
      yield result();
    }),
    send,
  );

  await prompt(server, "p1");

  assert.deepEqual(
    out.map((m) => (m.type === "event" ? m.event.kind : m.type)),
    ["init", "text", "tool_use", "tool_result", "done"],
  );
  const toolRes = out.find((m) => m.type === "event" && m.event.kind === "tool_result");
  assert.deepEqual(toolRes, {
    type: "event",
    conversation: "main",
    promptId: "p1",
    event: { kind: "tool_result", toolUseId: "t1", isError: false, content: "ok" },
  });
  assert.deepEqual(out.at(-1), {
    type: "done",
    conversation: "main",
    promptId: "p1",
    sessionId: "s1",
    isError: false,
    costUsd: 0.01,
    costTotal: 0.01,
    durationMs: 5,
    result: "fim",
  });
  assert.equal(server.busy, false);
});

test("cada conversa retoma a própria sessão e reset esquece só a dela", async () => {
  const calls: Options[] = [];
  const server = new AgentServer(
    fakeQuery(async function* (options) {
      // A sessão nasce do cwd para distinguir as conversas.
      const session = `s-${options.cwd}`;
      yield init(session);
      yield result(session);
    }, calls),
    () => {},
  );
  const run = (id: string, conversation: string, cwd: string) =>
    server.handle({ type: "prompt", conversation, id, text: "x", cwd, mode: "plan" });

  await run("p1", "main", "a");
  await run("p2", "task:x", "b");
  await run("p3", "main", "a");
  await run("p4", "task:x", "b");
  await server.handle({ type: "reset", conversation: "main" });
  await run("p5", "main", "a");
  await run("p6", "task:x", "b");

  assert.deepEqual(
    calls.map((o) => o.resume),
    [undefined, undefined, "s-a", "s-b", undefined, "s-b"],
  );
  assert.equal(calls[0]?.permissionMode, "plan");
});

test("conversas diferentes rodam em paralelo; a mesma conversa recusa um segundo pedido", async () => {
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = new AgentServer(
    fakeQuery(async function* () {
      await gate;
      yield result();
    }),
    send,
  );

  const main = prompt(server, "p1", "main");
  const task = prompt(server, "p2", "task:x");
  await prompt(server, "p3", "main");

  assert.equal(server.isRunning("main"), true);
  assert.equal(server.isRunning("task:x"), true);
  assert.deepEqual(out[0], {
    type: "error",
    conversation: "main",
    promptId: "p3",
    message: "esta conversa já está executando um pedido",
  });

  release();
  await Promise.all([main, task]);
  const done = out.filter((m) => m.type === "done").map((m) => m.type === "done" && m.conversation);
  assert.deepEqual(done.sort(), ["main", "task:x"]);
  assert.equal(server.busy, false);
});

test("pede permissão à UI e respeita a resposta", async () => {
  const { out, send } = collect();
  const decisions: string[] = [];
  const server = new AgentServer(
    fakeQuery(async function* (options) {
      for (const tool of ["Bash", "Edit"]) {
        decisions.push(`${tool}:${await ask(options, tool)}`);
      }
      yield result();
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

  await prompt(server, "p1", "task:x");

  assert.deepEqual(decisions, ["Bash:allow", "Edit:deny"]);
  const requests = out.filter((m) => m.type === "permission_request");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.type === "permission_request" && requests[0].conversation, "task:x");
});

test("interromper nega permissões pendentes só da conversa interrompida", async () => {
  const { out, send } = collect();
  let decision = "";
  const server = new AgentServer(
    fakeQuery(async function* (options) {
      decision = await ask(options, "Bash");
      yield result();
    }),
    (msg) => {
      send(msg);
      if (msg.type === "permission_request") {
        queueMicrotask(() => void server.handle({ type: "interrupt", conversation: "main" }));
      }
    },
  );

  await prompt(server, "p1", "main");

  assert.equal(decision, "deny");
  assert.equal(server.busy, false);
  assert.equal(out.at(-1)?.type, "done");
});

test("modos full e review liberam aprovações; review sem edição", async () => {
  const calls: Options[] = [];
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield result();
    }, calls),
    () => {},
  );

  await prompt(server, "p1", "task:x", "full");
  await prompt(server, "p2", "main", "autonomous");
  await prompt(server, "p3", "review:x", "review");

  assert.equal(calls[0]?.permissionMode, "bypassPermissions");
  assert.equal(calls[0]?.allowDangerouslySkipPermissions, true);
  assert.equal(calls[0]?.disallowedTools, undefined);
  assert.equal(calls[1]?.permissionMode, "acceptEdits");
  assert.equal(calls[1]?.allowDangerouslySkipPermissions, undefined);
  // Revisão: roda comandos sem pedir, mas não pode editar.
  assert.equal(calls[2]?.permissionMode, "bypassPermissions");
  assert.deepEqual(calls[2]?.disallowedTools, ["Edit", "MultiEdit", "Write", "NotebookEdit"]);
});

test("erro do SDK vira error + done com isError", async () => {
  const { out, send } = collect();
  const server = new AgentServer(
    fakeQuery(async function* () {
      throw new Error("sem credenciais");
    }),
    send,
  );

  await prompt(server, "p1");

  assert.deepEqual(out[0], { type: "error", conversation: "main", promptId: "p1", message: "sem credenciais" });
  assert.equal(out[1]?.type, "done");
  assert.equal(out[1]?.type === "done" && out[1].isError, true);
});

test("mapeia autonomia para modo de permissão do SDK", () => {
  assert.equal(permissionModeFor("plan"), "plan");
  assert.equal(permissionModeFor("assisted"), "default");
  assert.equal(permissionModeFor("autonomous"), "acceptEdits");
  assert.equal(permissionModeFor("full"), "bypassPermissions");
  assert.equal(permissionModeFor("review"), "bypassPermissions");
});

test("custo por pedido desconta o total acumulado da sessão retomada", async () => {
  const { out, send } = collect();
  const totals = [0.1, 0.25, 0.25];
  let call = 0;
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield { ...result(), total_cost_usd: totals[call++] };
    }),
    send,
  );

  await prompt(server, "p1");
  await prompt(server, "p2");
  await prompt(server, "p3");
  await server.handle({ type: "reset", conversation: "main" });
  totals.push(0.05);
  await prompt(server, "p4");

  const costs = out.flatMap((m) => (m.type === "done" ? [m.costUsd] : []));
  assert.deepEqual(
    costs.map((c) => Math.round((c ?? 0) * 1000) / 1000),
    [0.1, 0.15, 0, 0.05],
  );
});

test("total menor que o anterior (sessão sem total salvo) conta inteiro", () => {
  const conv = { costTotal: 0.5 };
  assert.equal(incrementalCost(conv, 0.2), 0.2);
  assert.equal(conv.costTotal, 0.2);
});

test("retoma sessão e custo de uma conversa vinda de antes do reinício", async () => {
  const { out, send } = collect();
  const calls: Options[] = [];
  const server = new AgentServer(
    fakeQuery(async function* () {
      yield { ...result("s-antiga"), total_cost_usd: 0.4 };
    }, calls),
    send,
  );

  await server.handle({
    type: "prompt",
    conversation: "t:1",
    id: "p1",
    text: "x",
    cwd: "/p",
    mode: "plan",
    effort: "xhigh",
    resume: { sessionId: "s-antiga", costTotal: 0.3 },
  });

  assert.equal(calls[0]?.resume, "s-antiga");
  assert.equal(calls[0]?.effort, "xhigh");
  const done = out.find((m) => m.type === "done");
  assert.equal(done?.type === "done" && Math.round(done.costUsd! * 100) / 100, 0.1);
  assert.equal(done?.type === "done" && done.costTotal, 0.4);
});

test("registra o servidor MCP do app quando o Rust informa o binário", () => {
  assert.deepEqual(ideMcp("/p", "assisted", {}), {});
  const config = ideMcp("/proj", "assisted", { IDE_MCP_COMMAND: "/app/ide-mcp" });
  assert.deepEqual(config.mcpServers, {
    ide: { type: "stdio", command: "/app/ide-mcp", args: ["--root", "/proj"] },
  });
  // Só as de tree-sitter são aprovadas de antemão: as de LSP executam código do projeto.
  assert.deepEqual(config.allowedTools, IDE_READ_TOOLS);
  assert.equal(config.disallowedTools, undefined);
  assert.deepEqual(ideMcp("/proj", "plan", { IDE_MCP_COMMAND: "x" }).disallowedTools, IDE_LSP_TOOLS);
  assert.ok([...IDE_READ_TOOLS, ...IDE_LSP_TOOLS].every((t) => t.startsWith("mcp__ide__")));
});

test("o servidor MCP chega às opções do SDK, e plan não usa o servidor de linguagem", async () => {
  const before = process.env.IDE_MCP_COMMAND;
  process.env.IDE_MCP_COMMAND = "/app/ide-mcp";
  try {
    const calls: Options[] = [];
    const server = new AgentServer(
      fakeQuery(async function* () {
        yield result();
      }, calls),
      () => {},
    );
    await prompt(server, "p1", "main", "assisted");
    await prompt(server, "p2", "outra", "plan");
    await prompt(server, "p3", "review:x", "review");

    assert.ok(calls[0]?.mcpServers?.ide);
    assert.deepEqual(calls[0]?.allowedTools, IDE_READ_TOOLS);
    assert.equal(calls[0]?.disallowedTools, undefined);
    assert.deepEqual(calls[1]?.disallowedTools, IDE_LSP_TOOLS);
    assert.deepEqual(calls[2]?.disallowedTools, ["Edit", "MultiEdit", "Write", "NotebookEdit"]);
  } finally {
    if (before === undefined) delete process.env.IDE_MCP_COMMAND;
    else process.env.IDE_MCP_COMMAND = before;
  }
});
