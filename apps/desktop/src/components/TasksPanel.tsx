import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js";

import { isRunning, lastText, onAgentDone } from "../lib/agent";
import { type Task, taskDiff, taskDiscard, taskList, taskMerge } from "../lib/ipc";
import { type Verdict, parseVerdict } from "../lib/prompts";
import { remember, reviewConversation, reviewTask, slugify, startTask, taskConversation } from "../lib/tasks";
import AgentPanel from "./AgentPanel";
import { DiffView } from "./DiffPanel";

const VERDICT_LABEL: Record<Verdict, string> = {
  pronto: "revisão: pronto",
  ressalvas: "revisão: ressalvas",
  "nao-pronto": "revisão: não pronto",
};

export default function TasksPanel(props: { root: string; version: number; onChange: () => void }) {
  const [refresh, setRefresh] = createSignal(0);
  const [tasks] = createResource(
    () => ({ root: props.root, v: props.version, r: refresh() }),
    ({ root }) => taskList(root),
  );
  const [selected, setSelected] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);

  createEffect(() => remember(tasks() ?? []));
  // Commits e arquivos da tarefa mudam a cada execução.
  onCleanup(onAgentDone(() => setRefresh((n) => n + 1)));

  const current = () => tasks()?.find((t) => t.slug === selected()) ?? null;
  const reload = () => {
    setRefresh((n) => n + 1);
    props.onChange();
  };

  return (
    <div class="tasks">
      <aside class="task-list">
        <button
          class="primary"
          onClick={() => {
            setNotice(null);
            setCreating(true);
          }}
        >
          Nova tarefa
        </button>
        <Show when={tasks()?.length} fallback={<p class="muted small">Nenhuma tarefa aberta.</p>}>
          <ul class="plain">
            <For each={tasks()}>
              {(task) => (
                <li>
                  <button
                    class="task-item"
                    classList={{ active: !creating() && selected() === task.slug }}
                    onClick={() => {
                      setCreating(false);
                      setSelected(task.slug);
                    }}
                  >
                    <span class="mono">{task.slug}</span>
                    <span class="muted small ellipsis">{task.goal?.split("\n")[0] ?? "sem objetivo"}</span>
                    <TaskBadges task={task} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </aside>

      <section class="task-main">
        <Switch
          fallback={
            <div class="empty muted">
              <Show when={notice()}>{(n) => <p class="banner ok">{n()}</p>}</Show>
              <p>Crie uma tarefa ou selecione uma na lista.</p>
            </div>
          }
        >
          <Match when={creating()}>
            <NewTask
              root={props.root}
              onCreated={(task) => {
                setCreating(false);
                setSelected(task.slug);
                reload();
              }}
              onCancel={() => setCreating(false)}
            />
          </Match>
          <Match when={current()}>
            {(task) => (
              <TaskDetail
                root={props.root}
                task={task()}
                version={props.version + refresh()}
                onRemoved={(text) => {
                  setNotice(text);
                  setSelected(null);
                  reload();
                }}
                onChange={reload}
              />
            )}
          </Match>
        </Switch>
      </section>
    </div>
  );
}

function TaskBadges(props: { task: Task }) {
  const verdict = () => parseVerdict(lastText(reviewConversation(props.task.slug)));
  return (
    <span class="badges">
      <Show when={isRunning(taskConversation(props.task.slug))}>
        <span class="badge working">trabalhando</span>
      </Show>
      <Show when={isRunning(reviewConversation(props.task.slug))}>
        <span class="badge working">revisando</span>
      </Show>
      <Show when={props.task.ahead > 0}>
        <span class="badge">{props.task.ahead} commit(s)</span>
      </Show>
      <Show when={props.task.dirty}>
        <span class="badge warn">não commitado</span>
      </Show>
      <Show when={verdict()}>{(v) => <span class={`badge verdict-${v()}`}>{VERDICT_LABEL[v()]}</span>}</Show>
    </span>
  );
}

function NewTask(props: { root: string; onCreated: (task: Task) => void; onCancel: () => void }) {
  const [goal, setGoal] = createSignal("");
  const [criteria, setCriteria] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugEdited, setSlugEdited] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const effectiveSlug = () => (slugEdited() ? slug() : slugify(goal().split("\n")[0] ?? ""));

  const submit = async () => {
    if (!goal().trim() || !effectiveSlug()) return;
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await startTask(props.root, effectiveSlug(), goal(), criteria()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="new-task"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Nova tarefa autônoma</h2>
      <p class="muted small">
        O agente trabalha sozinho num worktree isolado (branch <code>task/{effectiveSlug() || "…"}</code>), sem pedir
        aprovação, e uma revisão roda automaticamente ao final. Nada muda no seu branch até você integrar.
      </p>
      <label>
        Objetivo
        <textarea
          rows={3}
          value={goal()}
          placeholder="Ex.: Adicionar validação de e-mail no cadastro"
          onInput={(e) => setGoal(e.currentTarget.value)}
        />
      </label>
      <label>
        <span>
          Critérios de aceite <span class="muted small">(um por linha; opcional)</span>
        </span>
        <textarea
          rows={4}
          value={criteria()}
          placeholder={"- e-mail inválido mostra erro\n- testes cobrindo os casos"}
          onInput={(e) => setCriteria(e.currentTarget.value)}
        />
      </label>
      <label>
        <span>
          Nome <span class="muted small">(a-z, 0-9 e -)</span>
        </span>
        <input
          class="mono"
          value={effectiveSlug()}
          onInput={(e) => {
            setSlugEdited(true);
            setSlug(e.currentTarget.value);
          }}
        />
      </label>
      <Show when={error()}>
        <p class="error small">{error()}</p>
      </Show>
      <div class="row">
        <button type="submit" class="primary" disabled={busy() || !goal().trim() || !effectiveSlug()}>
          Criar e iniciar
        </button>
        <button type="button" class="ghost" onClick={() => props.onCancel()}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

type View = "agent" | "review" | "diff";

function TaskDetail(props: {
  root: string;
  task: Task;
  version: number;
  onRemoved: (notice: string) => void;
  onChange: () => void;
}) {
  const [view, setView] = createSignal<View>("agent");
  const [message, setMessage] = createSignal<{ error: boolean; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [diff] = createResource(
    () => (view() === "diff" ? { slug: props.task.slug, v: props.version } : null),
    ({ slug }) => taskDiff(props.root, slug),
  );
  const busy = () => isRunning(taskConversation(props.task.slug)) || isRunning(reviewConversation(props.task.slug));

  const merge = async () => {
    setMessage(null);
    try {
      const commit = await taskMerge(props.root, props.task.slug);
      // Integrada: o worktree e o branch não são mais necessários.
      await taskDiscard(props.root, props.task.slug);
      props.onRemoved(`Tarefa ${props.task.slug} integrada em ${commit}; worktree removido.`);
    } catch (e) {
      setMessage({ error: true, text: String(e) });
    }
  };

  const discard = async () => {
    if (!confirmDiscard()) {
      setConfirmDiscard(true);
      return;
    }
    try {
      await taskDiscard(props.root, props.task.slug);
      props.onRemoved(`Tarefa ${props.task.slug} descartada.`);
    } catch (e) {
      setMessage({ error: true, text: String(e) });
    }
  };

  return (
    <div class="task-detail">
      <header class="task-head">
        <div class="grow">
          <h2 class="mono">{props.task.branch}</h2>
          <p class="small task-goal">{props.task.goal}</p>
          <p class="muted small mono ellipsis" title={props.task.path}>
            {props.task.path}
          </p>
        </div>
        <div class="row">
          <button disabled={busy()} onClick={() => void reviewTask(props.task)}>
            Revisar
          </button>
          <button class="primary" disabled={busy() || props.task.ahead === 0} onClick={() => void merge()}>
            Integrar
          </button>
          <button classList={{ danger: confirmDiscard() }} disabled={busy()} onClick={() => void discard()}>
            {confirmDiscard() ? "Confirmar descarte" : "Descartar"}
          </button>
        </div>
      </header>
      <Show when={message()}>
        {(m) => <p class={`small banner ${m().error ? "error" : "ok"}`}>{m().text}</p>}
      </Show>

      <nav class="tabs sub">
        <button classList={{ active: view() === "agent" }} onClick={() => setView("agent")}>
          Agente
        </button>
        <button classList={{ active: view() === "review" }} onClick={() => setView("review")}>
          Revisão
        </button>
        <button classList={{ active: view() === "diff" }} onClick={() => setView("diff")}>
          Diff
        </button>
      </nav>
      <div class="task-view">
        <Switch>
          <Match when={view() === "agent"}>
            <AgentPanel
              conversation={taskConversation(props.task.slug)}
              cwd={props.task.path}
              modes={["full", "autonomous", "assisted", "plan"]}
              empty="Esta tarefa ainda não tem conversa. Peça algo ao agente para continuar o trabalho."
            />
          </Match>
          <Match when={view() === "review"}>
            <AgentPanel
              conversation={reviewConversation(props.task.slug)}
              cwd={props.task.path}
              modes={["review"]}
              empty="A revisão roda automaticamente quando a tarefa termina. Use “Revisar” para rodar de novo."
            />
          </Match>
          <Match when={view() === "diff"}>
            <div class="diff">
              <Show when={!diff.error} fallback={<p class="error">{String(diff.error)}</p>}>
                <Show when={diff()} fallback={<p class="empty muted">Nenhuma mudança desde a base.</p>}>
                  {(text) => <DiffView text={text()} />}
                </Show>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
