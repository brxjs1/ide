import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";

import { isTauri } from "./ipc";

// Espelha packages/agent/src/protocol.ts e crates/agent — mudou um, mude os três.
export type AutonomyMode = "plan" | "assisted" | "autonomous" | "full" | "review";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

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
      costTotal: number | null;
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

/** Sessão do SDK, guardada para retomar a conversa depois de reiniciar o app. */
export interface Session {
  sessionId: string;
  costTotal: number;
}

export interface Conversation {
  items: ChatItem[];
  /** promptId em execução. */
  running: string | null;
  session: Session | null;
}

const EMPTY: Conversation = { items: [], running: null, session: null };

const [state, setStore] = createStore<{ conversations: Record<string, Conversation> }>({ conversations: {} });

// Contador reativo de mudanças: unwrap() (usado para persistir) não é rastreado pelo
// Solid, então quem precisa reagir a qualquer mudança nas conversas observa este sinal.
const [revision, setRevision] = createSignal(0);
export { revision };

const setState: typeof setStore = ((...args: unknown[]) => {
  (setStore as (...a: unknown[]) => void)(...args);
  setRevision((n) => n + 1);
}) as typeof setStore;

/** Conversa reativa (vazia se ainda não existe). */
export const conversation = (id: string): Conversation => state.conversations[id] ?? EMPTY;

export const isRunning = (id: string) => conversation(id).running !== null;

export const anyRunning = () => Object.values(state.conversations).some((c) => c.running !== null);

/** Pedidos de permissão aguardando resposta, em qualquer conversa. */
export const pendingPermissions = (id: string) =>
  conversation(id).items.filter((i) => i.kind === "permission" && i.status === "pending").length;

/** Último texto do agente na conversa. */
export function lastText(id: string): string | null {
  const items = conversation(id).items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "text") return item.text;
  }
  return null;
}

/** Cópia simples de todas as conversas, para persistir. */
export const snapshot = () => unwrap(state.conversations);

/** Restaura conversas salvas (nada fica "rodando" depois de reiniciar). */
export function hydrate(saved: Record<string, Pick<Conversation, "items" | "session">>) {
  for (const [id, conv] of Object.entries(saved)) {
    const items = conv.items.map((item) =>
      item.kind === "permission" && item.status === "pending" ? { ...item, status: "denied" as const } : item,
    );
    setState("conversations", id, { items, running: null, session: conv.session ?? null });
  }
}

export function forget(id: string) {
  setState(
    "conversations",
    produce((all) => {
      delete all[id];
    }),
  );
}

export type DoneListener = (conversation: string, isError: boolean) => void;
const doneListeners = new Set<DoneListener>();
/** Chamado ao fim de cada execução (para atualizar git, disparar revisão, etc.). */
export function onAgentDone(fn: DoneListener): () => void {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

export type ErrorListener = (conversation: string, message: string) => void;
const errorListeners = new Set<ErrorListener>();
/** Erros do agente (para avisos na interface). */
export function onAgentError(fn: ErrorListener): () => void {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

function ensure(id: string) {
  if (!state.conversations[id]) setState("conversations", id, { items: [], running: null, session: null });
}

function push(id: string, item: ChatItem) {
  ensure(id);
  setState("conversations", id, "items", (items) => [...items, item]);
}

function fail(id: string, message: string) {
  push(id, { kind: "error", message });
  errorListeners.forEach((fn) => fn(id, message));
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
      if (msg.sessionId) {
        setState("conversations", msg.conversation, "session", {
          sessionId: msg.sessionId,
          costTotal: msg.costTotal ?? 0,
        });
      }
      if (msg.promptId === state.conversations[msg.conversation]?.running) finish(msg.conversation, msg.isError);
      return;
    case "error":
      fail(msg.conversation ?? "t:main", msg.message);
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
      fail(id, `o processo do agente encerrou (código ${e.payload ?? "?"})`);
      finish(id, true);
    }
  });
}

let counter = 0;

export interface PromptOptions {
  /** Texto mostrado no chat no lugar do prompt (prompts gerados). */
  display?: string;
  model?: string;
  effort?: Effort;
}

export async function sendPrompt(
  id: string,
  text: string,
  cwd: string,
  mode: AutonomyMode,
  options: PromptOptions = {},
): Promise<void> {
  const promptId = `p-${Date.now()}-${++counter}`;
  const session = conversation(id).session;
  push(id, { kind: "user", text: options.display ?? text, mode });
  setState("conversations", id, "running", promptId);
  try {
    await invoke("agent_send", {
      message: {
        type: "prompt",
        conversation: id,
        id: promptId,
        text,
        cwd,
        mode,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(session ? { resume: { sessionId: session.sessionId, costTotal: session.costTotal } } : {}),
      },
    });
  } catch (e) {
    fail(id, String(e));
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

/** Esquece a sessão (no sidecar e aqui) e limpa o chat. */
export async function resetConversation(id: string): Promise<void> {
  if (isRunning(id)) return;
  setState("conversations", id, { items: [], running: null, session: null });
  await invoke("agent_send", { message: { type: "reset", conversation: id } }).catch(() => {});
}
