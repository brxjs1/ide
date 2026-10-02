// Threads: cada conversa com o agente, no checkout atual ou num worktree de tarefa.
// Persistidas no localStorage junto com as mensagens e a sessão do SDK, para
// continuar de onde parou depois de reiniciar o app.
import { createEffect, createRoot, on } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { type AutonomyMode, type ChatItem, type Effort, type Session, hydrate, revision, snapshot } from "./agent";
import type { Task } from "./ipc";

export type Location = { kind: "local" } | { kind: "worktree"; slug: string; path: string };

export interface Thread {
  id: string;
  project: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  location: Location;
  /** Conversa principal no sidecar: "t:<id>" ou "task:<slug>". */
  conversation: string;
  model: string;
  effort: Effort;
  mode: AutonomyMode;
  /** Integrada, descartada ou arquivada: vai para "Concluídas". */
  settled: boolean;
}

export const SENTINEL_CONVERSATION = "watch:main";

const STORAGE_KEY = "ide.threads.v1";
const MAX_ITEMS = 400;

interface Saved {
  threads: Thread[];
  conversations: Record<string, { items: ChatItem[]; session: Session | null }>;
}

const [store, setStore] = createStore<{ threads: Thread[] }>({ threads: [] });

export const threads = () => store.threads;
export const threadById = (id: string | null) => store.threads.find((t) => t.id === id) ?? null;

export function load(project: string) {
  currentProject = project;
  const saved = readSaved();
  setStore(
    "threads",
    saved.threads.filter((t) => t.project === project),
  );
  hydrate(saved.conversations ?? {});
}

let currentProject: string | null = null;

function readSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Saved;
  } catch {
    /* corrompido: recomeça */
  }
  return { threads: [], conversations: {} };
}

/**
 * O localStorage é compartilhado por todos os projetos abertos no app: grava as threads
 * deste projeto sem tocar nas dos outros.
 */
function persist() {
  if (!currentProject) return;
  try {
    const saved = readSaved();
    const mine = new Set(store.threads.map((t) => t.conversation));
    const others = saved.threads.filter((t) => t.project !== currentProject);
    const conversations: Saved["conversations"] = {};
    for (const [id, conv] of Object.entries(saved.conversations ?? {})) {
      if (!mine.has(id)) conversations[id] = conv;
    }
    for (const [id, conv] of Object.entries(snapshot())) {
      conversations[id] = { items: conv.items.slice(-MAX_ITEMS), session: conv.session };
    }
    const threads = [...others, ...store.threads];
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ threads, conversations } satisfies Saved));
  } catch (e) {
    console.warn("threads: não foi possível salvar", e);
  }
}

// Salva com debounce sempre que threads ou conversas mudam.
createRoot(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => [JSON.stringify(store.threads), revision()],
      () => {
        clearTimeout(timer);
        timer = setTimeout(persist, 400);
      },
      { defer: true },
    ),
  );
});

// Último salvamento ao fechar (o debounce poderia perder as mudanças finais).
window.addEventListener("beforeunload", persist);

export interface NewThread {
  project: string;
  location: Location;
  model: string;
  effort: Effort;
  mode: AutonomyMode;
  title?: string;
}

export function createThread(spec: NewThread): Thread {
  const id = crypto.randomUUID().slice(0, 8);
  const now = Date.now();
  const thread: Thread = {
    id,
    project: spec.project,
    title: spec.title ?? "Nova thread",
    createdAt: now,
    updatedAt: now,
    location: spec.location,
    conversation: spec.location.kind === "worktree" ? `task:${spec.location.slug}` : `t:${id}`,
    model: spec.model,
    effort: spec.effort,
    mode: spec.mode,
    settled: false,
  };
  setStore("threads", (list) => [thread, ...list]);
  return thread;
}

export function updateThread(id: string, patch: Partial<Omit<Thread, "id">>) {
  setStore(
    "threads",
    (t) => t.id === id,
    produce((t) => Object.assign(t, patch, { updatedAt: Date.now() })),
  );
}

export function removeThread(id: string) {
  setStore("threads", (list) => list.filter((t) => t.id !== id));
}

/** Título a partir da primeira mensagem. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Nova thread";
}

/** Worktrees de tarefa sem thread (criados antes, ou por scripts/worktree.sh) viram threads. */
export function adoptTasks(project: string, tasks: Task[], defaults: Pick<Thread, "model" | "effort">) {
  const known = new Set(store.threads.flatMap((t) => (t.location.kind === "worktree" ? [t.location.slug] : [])));
  for (const task of tasks) {
    if (known.has(task.slug)) continue;
    createThread({
      project,
      location: { kind: "worktree", slug: task.slug, path: task.path },
      title: titleFrom(task.goal ?? task.slug),
      mode: "full",
      ...defaults,
    });
  }
  // Threads de worktree cujo worktree sumiu (integrado/descartado fora do app) ficam concluídas.
  const alive = new Set(tasks.map((t) => t.slug));
  for (const thread of store.threads) {
    if (thread.location.kind === "worktree" && !thread.settled && !alive.has(thread.location.slug)) {
      updateThread(thread.id, { settled: true });
    }
  }
}

/** "agora", "5min", "3h", "20d". */
export function age(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "agora";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
