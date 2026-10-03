// Threads em worktree (tarefas autônomas) e revisões.
import { type Effort, onAgentDone, resetConversation, sendPrompt } from "./agent";
import { changedFiles, fileDiff, taskCreate, taskList } from "./ipc";
import { reviewPrompt, taskPrompt } from "./prompts";
import { type Thread, createThread, threads, titleFrom } from "./threads";

export const reviewConversation = (slug: string) => `review:${slug}`;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Slug livre: acrescenta -2, -3... se o nome já existe entre as tarefas. */
async function freeSlug(root: string, base: string): Promise<string> {
  const taken = new Set((await taskList(root)).map((t) => t.slug));
  const seed = base || "tarefa";
  if (!taken.has(seed)) return seed;
  for (let i = 2; ; i++) {
    const candidate = `${seed.slice(0, 36)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface Draft {
  model: string;
  effort: Effort;
}

/**
 * Nova thread em worktree: cria o worktree task/<slug> e inicia o agente em modo full.
 * A primeira mensagem é o objetivo da tarefa.
 */
export async function startWorktreeThread(root: string, text: string, draft: Draft): Promise<Thread> {
  const slug = await freeSlug(root, slugify(text.split("\n")[0] ?? ""));
  const task = await taskCreate(root, slug, text);
  const thread = createThread({
    project: root,
    location: { kind: "worktree", slug, path: task.path },
    title: titleFrom(text),
    mode: "full",
    ...draft,
  });
  void sendPrompt(thread.conversation, taskPrompt(slug, text, ""), task.path, "full", {
    display: text,
    model: draft.model,
    effort: draft.effort,
  });
  return thread;
}

/** Revisão da tarefa em conversa nova (contexto limpo), podendo rodar testes. */
export async function reviewTask(root: string, thread: Thread): Promise<void> {
  if (thread.location.kind !== "worktree") return;
  const { slug, path } = thread.location;
  const task = (await taskList(root)).find((t) => t.slug === slug);
  const id = reviewConversation(slug);
  await resetConversation(id);
  await sendPrompt(
    id,
    reviewPrompt({
      label: slug,
      diffCommand: `git diff ${(task?.base ?? "HEAD~1").slice(0, 12)}...HEAD (e alterações pendentes em git status)`,
      canRunTests: true,
    }),
    path,
    "review",
    { display: "Revisar tarefa", model: thread.model, effort: thread.effort },
  );
}

/** Revisa o working tree do branch atual (modo plan: o diff vai no prompt). */
export async function reviewWorkingTree(root: string, thread: Thread): Promise<void> {
  const files = await changedFiles(root);
  const diffs = await Promise.all(files.map((f) => fileDiff(root, f.path).catch((e: unknown) => `# ${f.path}: ${e}`)));
  await sendPrompt(
    thread.conversation,
    reviewPrompt({
      label: "working tree",
      diffCommand: "git diff HEAD + arquivos novos",
      canRunTests: false,
      diff: diffs.join("\n"),
    }),
    root,
    "plan",
    {
      display: `Revisar ${files.length} arquivo(s) alterado(s) antes do commit`,
      model: thread.model,
      effort: thread.effort,
    },
  );
}

/** Concatena os diffs do working tree (para a Sentinela). */
export async function workingTreeDiff(root: string): Promise<{ files: number; diff: string }> {
  const files = await changedFiles(root);
  const diffs = await Promise.all(files.map((f) => fileDiff(root, f.path).catch(() => "")));
  return { files: files.length, diff: diffs.join("\n") };
}

// Pipeline: execução da tarefa terminou bem → revisão automática.
let currentRoot: string | null = null;
export const setRoot = (root: string) => (currentRoot = root);

onAgentDone((conversation, isError) => {
  if (isError || !conversation.startsWith("task:") || !currentRoot) return;
  const thread = threads().find((t) => t.conversation === conversation);
  if (thread) void reviewTask(currentRoot, thread);
});
