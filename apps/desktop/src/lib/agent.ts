import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";

import { isTauri } from "./ipc";

// Espelha packages/agent/src/protocol.ts e crates/agent — mudou um, mude os três.
export type AutonomyMode = "plan" | "assisted" | "autonomous" | "full" | "review";

type AgentEvent =
  | { kind: "init"; model: string; cwd: string; permissionMode: string; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string };

type Outbound =
  | { type: "ready" }
  | { type: "event"; conversation: string; promptId: string; event: AgentEvent }
  | { type: "permission_request"; conversation: string; id: string; promptId: string; toolName: string; input: unknown }
  | {
      type: "done";
      conversation: string;
      promptId: string;
      sessionId: string | null;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
      result: string | null;
    }
  | { type: "error"; conversation: string | null; promptId: string | null; message: string };

export type ChatItem =
  | { kind: "user"; text: string; mode: AutonomyMode }
  | { kind: "init"; model: string; permissionMode: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: { isError: boolean; content: string } }
  | { kind: "permission"; id: string; toolName: string; input: unknown; status: "pending" | "allowed" | "denied" }
  | { kind: "done"; isError: boolean; costUsd: number | null; durationMs: number | null }
  | { kind: "error"; message: string };

export interface Conversation {
  items: ChatItem[];
  /** promptId em execução. */
  running: string | null;
}

const EMPTY: Conversation = { items: [], running: null };

const [state, setState] = createStore<{ conversations: Record<string, Conversation> }>({ conversations: {} });

/** Conversa reativa (vazia se ainda não existe). */
export const conversation = (id: string): Conversation => state.conversations[id] ?? EMPTY;

export const isRunning = (id: string) => conversation(id).running !== null;

/** Último texto do agente na conversa. */
export function lastText(id: string): string | null {
  const items = conversation(id).items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "text") return item.text;
  }
  return null;
}

export type DoneListener = (conversation: string, isError: boolean) => void;
const doneListeners = new Set<DoneListener>();
/** Chamado ao fim de cada execução (para atualizar git, disparar revisão, etc.). */
export function onAgentDone(fn: DoneListener): () => void {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

function ensure(id: string) {
  if (!state.conversations[id]) setState("conversations", id, { items: [], running: null });
}

function push(id: string, item: ChatItem) {
  ensure(id);
  setState("conversations", id, "items", (items) => [...items, item]);
}

function finish(id: string, isError: boolean) {
  if (!state.conversations[id]?.running) return;
  setState("conversations", id, "running", null);
  doneListeners.forEach((fn) => fn(id, isError));
}

function handle(msg: Outbound) {
  switch (msg.type) {
    case "ready":
      return;
    case "event":
      return handleEvent(msg.conversation, msg.event);
    case "permission_request":
      return push(msg.conversation, {
        kind: "permission",
        id: msg.id,
        toolName: msg.toolName,
        input: msg.input,
        status: "pending",
      });
    case "done":
      push(msg.conversation, { kind: "done", isError: msg.isError, costUsd: msg.costUsd, durationMs: msg.durationMs });
      if (msg.promptId === state.conversations[msg.conversation]?.running) finish(msg.conversation, msg.isError);
      return;
    case "error":
      push(msg.conversation ?? "main", { kind: "error", message: msg.message });
      return;
  }
}

function handleEvent(id: string, event: AgentEvent) {
  switch (event.kind) {
    case "init":
      return push(id, { kind: "init", model: event.model, permissionMode: event.permissionMode });
    case "text":
      return push(id, { kind: "text", text: event.text });
    case "tool_use":
      return push(id, { kind: "tool", id: event.id, name: event.name, input: event.input });
    case "tool_result":
      ensure(id);
      return setState(
        "conversations",
        id,
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
    for (const [id, conv] of Object.entries(state.conversations)) {
      if (!conv.running) continue;
      push(id, { kind: "error", message: `o processo do agente encerrou (código ${e.payload ?? "?"})` });
      finish(id, true);
    }
  });
}

let counter = 0;

/**
 * Envia um pedido. `display` substitui o texto mostrado no chat (útil quando o prompt
 * é gerado, como nas tarefas e revisões).
 */
export async function sendPrompt(
  id: string,
  text: string,
  cwd: string,
  mode: AutonomyMode,
  display?: string,
): Promise<void> {
  const promptId = `p-${Date.now()}-${++counter}`;
  push(id, { kind: "user", text: display ?? text, mode });
  setState("conversations", id, "running", promptId);
  try {
    await invoke("agent_send", { message: { type: "prompt", conversation: id, id: promptId, text, cwd, mode } });
  } catch (e) {
    push(id, { kind: "error", message: String(e) });
    finish(id, true);
  }
}

export async function respondPermission(permissionId: string, allow: boolean): Promise<void> {
  for (const id of Object.keys(state.conversations)) {
    setState(
      "conversations",
      id,
      "items",
      (item) => item.kind === "permission" && item.id === permissionId,
      produce((item) => {
        if (item.kind === "permission") item.status = allow ? "allowed" : "denied";
      }),
    );
  }
  await invoke("agent_send", { message: { type: "permission_response", id: permissionId, allow } });
}

export const interrupt = (id: string) => invoke("agent_send", { message: { type: "interrupt", conversation: id } });

/** Nova conversa: esquece a sessão no sidecar e limpa o chat. */
export async function resetConversation(id: string): Promise<void> {
  if (isRunning(id)) return;
  setState("conversations", id, { items: [], running: null });
  await invoke("agent_send", { message: { type: "reset", conversation: id } }).catch(() => {});
}
