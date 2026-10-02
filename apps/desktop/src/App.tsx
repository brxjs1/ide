import { For, Match, Show, Switch, createResource } from "solid-js";

import { isTauri, projectInfo } from "./lib/ipc";

export default function App() {
  const [project, { refetch }] = createResource(() => (isTauri() ? projectInfo() : null));

  return (
    <div class="shell">
      <aside class="sidebar">
        <h1>ide</h1>
        <Switch>
          <Match when={!isTauri()}>
            <p class="muted">Rodando fora do Tauri. Use <code>pnpm dev</code> na raiz.</p>
          </Match>
          <Match when={project.error}>
            <p class="error">{String(project.error)}</p>
          </Match>
          <Match when={project()}>
            {(p) => (
              <>
                <section>
                  <h2>{p().name}</h2>
                  <p class="mono">
                    {p().branch ?? "HEAD destacado"}
                    <Show when={p().head}> @ {p().head}</Show>
                    <Show when={p().dirty}>
                      <span class="badge">alterado</span>
                    </Show>
                  </p>
                </section>
                <section>
                  <h3>Worktrees</h3>
                  <ul>
                    <For each={p().worktrees}>
                      {(w) => (
                        <li class="mono" title={w.path}>
                          {w.branch ?? "(destacado)"}
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </>
            )}
          </Match>
        </Switch>
        <Show when={isTauri()}>
          <button onClick={() => refetch()}>Atualizar</button>
        </Show>
      </aside>
      <main class="main">
        <p class="muted">Chat do agente, diff e terminal entram aqui (Fase 1).</p>
      </main>
    </div>
  );
}
