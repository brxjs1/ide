// Sidecar do agente: lê Inbound de stdin e escreve Outbound em stdout, uma linha JSON
// por mensagem. stderr é livre para logs.
import { createInterface } from "node:readline";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { Inbound, Outbound } from "./protocol.ts";
import { AgentServer } from "./server.ts";

const send = (msg: Outbound) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const server = new AgentServer(query, send);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let msg: Inbound;
  try {
    msg = JSON.parse(line) as Inbound;
  } catch {
    send({ type: "error", promptId: null, message: `linha inválida: ${line.slice(0, 200)}` });
    return;
  }
  server.handle(msg).catch((err: unknown) => {
    send({ type: "error", promptId: null, message: err instanceof Error ? err.message : String(err) });
  });
});
lines.on("close", () => process.exit(0));

send({ type: "ready" });
