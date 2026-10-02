import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";

import { isTauri } from "./ipc";

// Espelha packages/agent/src/protocol.ts e crates/agent.
export type AutonomyMode = "plan" | "assisted" | "autonomous";

type AgentEvent =
  | { kind: "init"; model: string; cwd: string; permissionMode: string; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string };

type Outbound =
  | { type: "ready" }
  | { type: "event"; promptId: string; event: AgentEvent }
  | { type: "permission_request"; id: string; promptId: string; toolName: string; input: unknown }
  | {
      type: "done";
      promptId: string;
      sessionId: string | null;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
      result: string | null;
    }
  | { type: "error"; promptId: string | null; message: string };

export type ChatItem =
  | { kind: "user"; text: string; mode: AutonomyMode }
  | { kind: "init"; model: string; permissionMode: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: { isError: boolean; content: string } }
  | { kind: "permission"; id: string; toolName: string; input: unknown; status: "pending" | "allowed" | "denied" }
  | { kind: "done"; isError: boolean; costUsd: number | null; durationMs: number | null }
  | { kind: "error"; message: string };

interface AgentState {
  items: ChatItem[];
  running: string | null;
}

const [state, setState] = createStore<AgentState>({ items: [], running: null });
export const agent = state;

const doneListeners = new Set<() => void>();
/** Chamado ao fim de cada execução (para atualizar git, diff, etc.). */
export function onAgentDone(fn: () => void): () => void {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

const push = (item: ChatItem) => setState("items", (items) => [...items, item]);

function finish() {
  setState("running", null);
  doneListeners.forEach((fn) => fn());
}

function handle(msg: Outbound) {
  switch (msg.type) {
    case "ready":
      return;
    case "event":
      return handleEvent(msg.event);
    case "permission_request":
      return push({ kind: "permission", id: msg.id, toolName: msg.toolName, input: msg.input, status: "pending" });
    case "done":
      push({ kind: "done", isError: msg.isError, costUsd: msg.costUsd, durationMs: msg.durationMs });
      if (msg.promptId === state.running) finish();
      return;
    case "error":
      push({ kind: "error", message: msg.message });
      return;
  }
}

function handleEvent(event: AgentEvent) {
  switch (event.kind) {
    case "init":
      return push({ kind: "init", model: event.model, permissionMode: event.permissionMode });
    case "text":
      return push({ kind: "text", text: event.text });
    case "tool_use":
      return push({ kind: "tool", id: event.id, name: event.name, input: event.input });
    case "tool_result":
      return setState(
        "items",
        (item) => item.kind === "tool" && item.id === event.toolUseId,
        produce((item) => {
          if (item.kind === "tool") item.result = { isError: event.isError, content: event.content };
        }),
      );
  }
}

if (isTauri()) {
  void listen<Outbound>("agent://message", (e) => handle(e.payload));
  void listen<number | null>("agent://exit", (e) => {
    if (!state.running) return;
    push({ kind: "error", message: `o processo do agente encerrou (código ${e.payload ?? "?"})` });
    finish();
  });
}

let counter = 0;

export async function sendPrompt(text: string, cwd: string, mode: AutonomyMode): Promise<void> {
  const id = `p-${Date.now()}-${++counter}`;
  push({ kind: "user", text, mode });
  setState("running", id);
  try {
    await invoke("agent_send", { message: { type: "prompt", id, text, cwd, mode } });
  } catch (e) {
    push({ kind: "error", message: String(e) });
    finish();
  }
}

export async function respondPermission(id: string, allow: boolean): Promise<void> {
  setState(
    "items",
    (item) => item.kind === "permission" && item.id === id,
    produce((item) => {
      if (item.kind === "permission") item.status = allow ? "allowed" : "denied";
    }),
  );
  await invoke("agent_send", { message: { type: "permission_response", id, allow } });
}

export const interrupt = () => invoke("agent_send", { message: { type: "interrupt" } });

/** Nova conversa: esquece a sessão no sidecar e limpa o chat. */
export async function resetConversation(): Promise<void> {
  if (state.running) return;
  setState("items", []);
  await invoke("agent_send", { message: { type: "reset" } }).catch(() => {});
}
