import { Match, Show, Switch, createResource, createSignal, onCleanup } from "solid-js";

import AgentPanel from "./components/AgentPanel";
import DiffPanel from "./components/DiffPanel";
import Sidebar from "./components/Sidebar";
import Terminal from "./components/Terminal";
import TasksPanel from "./components/TasksPanel";
import TimelinePanel from "./components/TimelinePanel";
import { onAgentDone } from "./lib/agent";
import { changedFiles, isTauri, projectInfo } from "./lib/ipc";
import { reviewWorkingTree } from "./lib/tasks";

type Tab = "agent" | "tasks" | "diff" | "timeline";

export default function App() {
  const [version, setVersion] = createSignal(0);
  const refresh = () => setVersion((v) => v + 1);

  const [project] = createResource(version, () => (isTauri() ? projectInfo() : null));
  const [files] = createResource(
    () => project() && { root: project()!.root, v: version() },
    ({ root }) => changedFiles(root),
  );
  const [tab, setTab] = createSignal<Tab>("agent");
  const [selected, setSelected] = createSignal<string | null>(null);
  // Worktrees de tarefa aparecem na lista do projeto; contá-los evita outra chamada.
  const tasksCount = () => project()?.worktrees.filter((w) => w.branch?.startsWith("task/")).length ?? 0;

  // O agente e o terminal mudam arquivos: atualiza git ao fim de cada execução e ao focar a janela.
  onCleanup(onAgentDone(refresh));
  window.addEventListener("focus", refresh);
  onCleanup(() => window.removeEventListener("focus", refresh));

  return (
    <Switch>
      <Match when={!isTauri()}>
        <p class="empty muted">
          Rodando fora do Tauri. Use <code>pnpm dev</code> na raiz.
        </p>
      </Match>
      <Match when={project.error}>
        <p class="empty error">{String(project.error)}</p>
      </Match>
      <Match when={project()}>
        {(p) => (
          <div class="shell">
            <Sidebar
              project={p()}
              files={files() ?? []}
              selected={selected()}
              onRefresh={refresh}
              onSelect={(path) => {
                setSelected(path);
                setTab("diff");
              }}
            />
            <main class="main">
              <nav class="tabs">
                <button classList={{ active: tab() === "agent" }} onClick={() => setTab("agent")}>
                  Agente
                </button>
                <button classList={{ active: tab() === "tasks" }} onClick={() => setTab("tasks")}>
                  Tarefas
                  <Show when={tasksCount()}>
                    <span class="count">{tasksCount()}</span>
                  </Show>
                </button>
                <button classList={{ active: tab() === "diff" }} onClick={() => setTab("diff")}>
                  Diff
                  <Show when={files()?.length}>
                    <span class="count">{files()!.length}</span>
                  </Show>
                </button>
                <button classList={{ active: tab() === "timeline" }} onClick={() => setTab("timeline")}>
                  Timeline
                </button>
              </nav>
              <div class="content">
                {/* O chat fica montado para não perder o scroll ao trocar de aba. */}
                <div class="pane" hidden={tab() !== "agent"}>
                  <AgentPanel
                    conversation="main"
                    cwd={p().root}
                    modes={["assisted", "autonomous", "plan"]}
                    empty="Converse com o agente sobre este projeto. Para trabalho longo sem aprovações, use a aba Tarefas."
                  />
                </div>
                <Show when={tab() === "tasks"}>
                  <TasksPanel root={p().root} version={version()} onChange={refresh} />
                </Show>
                <Show when={tab() === "diff"}>
                  <DiffPanel
                    root={p().root}
                    path={selected()}
                    version={version()}
                    changed={files()?.length ?? 0}
                    onReview={() => {
                      setTab("agent");
                      void reviewWorkingTree(p().root);
                    }}
                  />
                </Show>
                <Show when={tab() === "timeline"}>
                  <TimelinePanel project={p().root} />
                </Show>
              </div>
              <Terminal cwd={p().root} />
            </main>
          </div>
        )}
      </Match>
    </Switch>
  );
}
