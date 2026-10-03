import { For, Show, createEffect, createResource, createSignal, on } from "solid-js";

import { notify } from "../lib/banners";
import { openFile } from "../lib/editor";
import { type BoardTask, type TaskStatus, boardCreate, boardDelete, boardList, boardSetStatus } from "../lib/ipc";
import { age } from "../lib/threads";
import Icon from "./Icons";

const COLUMNS: { status: TaskStatus; label: string; empty: string }[] = [
  { status: "todo", label: "A fazer", empty: "Nada na fila. Crie uma tarefa acima." },
  { status: "doing", label: "Em progresso", empty: "Arraste uma tarefa para cá quando começar." },
  { status: "done", label: "Concluídas", empty: "O que terminar aparece aqui." },
];
const ORDER: TaskStatus[] = ["todo", "doing", "done"];

/**
 * Quadro de tarefas do projeto (`.project/tasks/*.md`): a fazer, em progresso e
 * concluídas. Os arquivos continuam editáveis à mão e legíveis pelo agente.
 */
export default function BoardView(props: {
  root: string;
  version: number;
  onRun: (task: BoardTask) => Promise<void>;
  /** Algo mudou no quadro (contadores da barra lateral). */
  onChange: () => void;
}) {
  const [tasks, { mutate, refetch }] = createResource(
    () => props.root,
    (root) => boardList(root),
  );
  createEffect(on(() => props.version, () => void refetch(), { defer: true }));

  const [adding, setAdding] = createSignal(false);
  const [dragOver, setDragOver] = createSignal<TaskStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  // Ler o resource com erro relança a exceção (e quebraria a tela): o erro aparece em `.board-error`.
  const list = () => (tasks.state === "errored" ? [] : (tasks() ?? []));
  const column = (status: TaskStatus) => list().filter((t) => t.status === status);
  const replace = (task: BoardTask) => {
    mutate((list) => (list ?? []).map((t) => (t.slug === task.slug ? task : t)));
    props.onChange();
  };

  const move = async (task: BoardTask, status: TaskStatus) => {
    if (task.status === status) return;
    mutate((list) => (list ?? []).map((t) => (t.slug === task.slug ? { ...t, status } : t)));
    try {
      replace(await boardSetStatus(props.root, task.slug, status));
    } catch (e) {
      notify({ tone: "error", title: "Não foi possível mover a tarefa", text: String(e) });
      void refetch();
    }
  };

  const shift = (task: BoardTask, delta: number) => {
    const next = ORDER[ORDER.indexOf(task.status) + delta];
    if (next) void move(task, next);
  };

  const remove = async (task: BoardTask) => {
    if (confirmDelete() !== task.slug) {
      setConfirmDelete(task.slug);
      setTimeout(() => setConfirmDelete((s) => (s === task.slug ? null : s)), 4000);
      return;
    }
    setConfirmDelete(null);
    try {
      await boardDelete(props.root, task.slug);
      mutate((list) => (list ?? []).filter((t) => t.slug !== task.slug));
      props.onChange();
    } catch (e) {
      notify({ tone: "error", title: "Não foi possível apagar a tarefa", text: String(e) });
    }
  };

  const run = async (task: BoardTask) => {
    setBusy(task.slug);
    try {
      await props.onRun(task);
      await refetch();
    } finally {
      setBusy(null);
    }
  };

  const total = () => list().length;

  return (
    <div class="board">
      <header class="board-head">
        <div class="grow">
          <h2>Tarefas</h2>
          <p class="muted small">
            {total()
              ? `${column("doing").length} em progresso · ${column("todo").length} a fazer · ${column("done").length} concluída(s)`
              : "Guarde aqui o que precisa ser feito. Cada tarefa é um arquivo em .project/tasks/."}
          </p>
        </div>
        <button class="btn primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding()}>
          <Icon name="plus" size={14} /> Nova tarefa
        </button>
      </header>

      <Show when={tasks.error}>
        <p class="board-error">Não foi possível ler o quadro: {String(tasks.error)}</p>
      </Show>

      <div class="board-columns">
        <For each={COLUMNS}>
          {(col) => (
            <section
              class={`board-column col-${col.status}`}
              classList={{ "drop-target": dragOver() === col.status }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(col.status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const slug = e.dataTransfer?.getData("text/plain");
                const task = list().find((t) => t.slug === slug);
                if (task) void move(task, col.status);
              }}
            >
              <header class="column-head">
                <span class="column-dot" />
                <span>{col.label}</span>
                <span class="chip-count">{column(col.status).length}</span>
              </header>

              <Show when={col.status === "todo" && adding()}>
                <NewTask
                  onCancel={() => setAdding(false)}
                  onCreate={async (title, priority, description) => {
                    try {
                      const task = await boardCreate(props.root, title, "todo", priority, description);
                      mutate((list) => [task, ...(list ?? [])]);
                      props.onChange();
                      return true;
                    } catch (e) {
                      notify({ tone: "error", title: "Não foi possível criar a tarefa", text: String(e) });
                      return false;
                    }
                  }}
                />
              </Show>

              <div class="column-body">
                <For each={column(col.status)} fallback={<p class="column-empty">{col.empty}</p>}>
                  {(task) => (
                    <article
                      class="task-card"
                      classList={{ busy: busy() === task.slug }}
                      draggable="true"
                      onDragStart={(e) => {
                        e.dataTransfer?.setData("text/plain", task.slug);
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      <div class="task-top">
                        <h3 class="task-title">{task.title}</h3>
                        <Show when={task.priority}>
                          <span class={`priority priority-${(task.priority ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}`}>
                            {task.priority}
                          </span>
                        </Show>
                      </div>
                      <Show when={task.summary}>
                        <p class="task-summary">{task.summary}</p>
                      </Show>
                      <Show when={task.checklistTotal > 0}>
                        <div class="task-progress" aria-label={`${task.checklistDone} de ${task.checklistTotal} critérios`}>
                          <div class="meter">
                            <span style={{ width: `${(task.checklistDone / task.checklistTotal) * 100}%` }} />
                          </div>
                          <span class="faint small">
                            {task.checklistDone}/{task.checklistTotal}
                          </span>
                        </div>
                      </Show>
                      <footer class="task-foot">
                        <Show when={task.worktree}>
                          <span class="pill working-tree">
                            <Icon name="worktree" size={11} /> {task.worktree}
                          </span>
                        </Show>
                        <span class="faint small">{age(task.updated * 1000)}</span>
                        <span class="grow" />
                        <div class="task-actions">
                          <button
                            class="icon-btn"
                            disabled={task.status === "todo"}
                            onClick={() => shift(task, -1)}
                            aria-label="Mover para a coluna anterior"
                            data-tip="Voltar"
                          >
                            <Icon name="arrowLeft" size={13} />
                          </button>
                          <button
                            class="icon-btn"
                            disabled={task.status === "done"}
                            onClick={() => shift(task, 1)}
                            aria-label="Mover para a próxima coluna"
                            data-tip="Avançar"
                          >
                            <Icon name="arrowRight" size={13} />
                          </button>
                          <button
                            class="icon-btn"
                            onClick={() => void openFile(task.path)}
                            aria-label="Editar o arquivo da tarefa"
                            data-tip="Editar"
                          >
                            <Icon name="edit" size={13} />
                          </button>
                          <Show when={task.status !== "done" && !task.worktree}>
                            <button
                              class="icon-btn accent"
                              disabled={busy() !== null}
                              onClick={() => void run(task)}
                              aria-label="Entregar ao agente num worktree"
                              data-tip="Executar com o agente"
                            >
                              <Icon name="play" size={12} />
                            </button>
                          </Show>
                          <button
                            class="icon-btn"
                            classList={{ danger: confirmDelete() === task.slug }}
                            onClick={() => void remove(task)}
                            aria-label={confirmDelete() === task.slug ? "Confirmar exclusão" : "Apagar tarefa"}
                            data-tip={confirmDelete() === task.slug ? "Clique de novo para apagar" : "Apagar"}
                            data-tip-align="end"
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </footer>
                    </article>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

function NewTask(props: {
  onCreate: (title: string, priority: string | null, description: string | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [priority, setPriority] = createSignal("média");
  const [description, setDescription] = createSignal("");
  let input!: HTMLInputElement;
  queueMicrotask(() => input?.focus());

  const submit = async () => {
    if (!title().trim()) return;
    const ok = await props.onCreate(title().trim(), priority() || null, description().trim() || null);
    if (ok) {
      setTitle("");
      setDescription("");
      input?.focus();
    }
  };

  return (
    <form
      class="task-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
        // Ctrl+Enter cria de qualquer campo (Enter no objetivo quebra linha).
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <input ref={input} placeholder="Título da tarefa" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
      <textarea
        placeholder="Objetivo (opcional)"
        rows={2}
        value={description()}
        onInput={(e) => setDescription(e.currentTarget.value)}
      />
      <div class="task-form-row">
        <select value={priority()} onChange={(e) => setPriority(e.currentTarget.value)} aria-label="Prioridade">
          <option value="alta">Prioridade alta</option>
          <option value="média">Prioridade média</option>
          <option value="baixa">Prioridade baixa</option>
          <option value="">Sem prioridade</option>
        </select>
        <span class="grow" />
        <button type="button" class="btn ghost-border small" onClick={() => props.onCancel()}>
          Cancelar
        </button>
        <button type="submit" class="btn primary small" disabled={!title().trim()}>
          Criar
        </button>
      </div>
    </form>
  );
}
