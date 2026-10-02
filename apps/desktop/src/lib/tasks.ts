// Orquestração das tarefas: criar → agente em modo full no worktree → revisão
// automática em contexto limpo quando a execução termina bem.
import { onAgentDone, resetConversation, sendPrompt } from "./agent";
import { type Task, changedFiles, fileDiff, taskCreate } from "./ipc";
import { reviewPrompt, taskPrompt } from "./prompts";

export const taskConversation = (slug: string) => `task:${slug}`;
export const reviewConversation = (slug: string) => `review:${slug}`;

/** Tarefas conhecidas, para a revisão automática saber onde rodar. */
const known = new Map<string, Task>();

export function remember(tasks: Task[]) {
  known.clear();
  for (const task of tasks) known.set(task.slug, task);
}

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

export async function startTask(root: string, slug: string, goal: string, criteria: string): Promise<Task> {
  const task = await taskCreate(root, slug, goal);
  known.set(task.slug, task);
  void sendPrompt(
    taskConversation(slug),
    taskPrompt(slug, goal, criteria),
    task.path,
    "full",
    `Tarefa: ${goal.trim().split("\n")[0]}`,
  );
  return task;
}

/** Revisa a tarefa em uma conversa nova (contexto limpo), podendo rodar testes. */
export async function reviewTask(task: Task): Promise<void> {
  const id = reviewConversation(task.slug);
  await resetConversation(id);
  const base = task.base ?? "HEAD~1";
  await sendPrompt(
    id,
    reviewPrompt({
      label: task.slug,
      diffCommand: `git diff ${base.slice(0, 12)}...HEAD (e alterações pendentes em git status)`,
      canRunTests: true,
    }),
    task.path,
    "review",
    "Revisar tarefa",
  );
}

/** Revisa o working tree do branch atual. Sem executar comandos (modo plan): o diff vai no prompt. */
export async function reviewWorkingTree(root: string): Promise<void> {
  const files = await changedFiles(root);
  const diffs = await Promise.all(files.map((f) => fileDiff(root, f.path).catch((e: unknown) => `# ${f.path}: ${e}`)));
  await sendPrompt(
    "main",
    reviewPrompt({
      label: "working tree",
      diffCommand: "git diff HEAD + arquivos novos",
      canRunTests: false,
      diff: diffs.join("\n"),
    }),
    root,
    "plan",
    `Revisar ${files.length} arquivo(s) alterado(s) antes do commit`,
  );
}

// Pipeline: execução da tarefa terminou bem → revisão automática.
onAgentDone((conversation, isError) => {
  if (isError || !conversation.startsWith("task:")) return;
  const task = known.get(conversation.slice("task:".length));
  if (task) void reviewTask(task);
});
