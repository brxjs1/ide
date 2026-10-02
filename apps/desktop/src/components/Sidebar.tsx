import { For, Show } from "solid-js";

import type { ChangedFile, FileStatus, ProjectInfo } from "../lib/ipc";

const STATUS_LETTER: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

export default function Sidebar(props: {
  project: ProjectInfo;
  files: ChangedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside class="sidebar">
      <section>
        <h2 title={props.project.root}>{props.project.name}</h2>
        <p class="mono muted">
          {props.project.branch ?? "HEAD destacado"}
          <Show when={props.project.head}> @ {props.project.head}</Show>
        </p>
      </section>

      <section>
        <div class="section-head">
          <h3>Alterações</h3>
          <button class="ghost" onClick={() => props.onRefresh()} title="Atualizar">
            ↻
          </button>
        </div>
        <Show when={props.files.length} fallback={<p class="muted small">Nada alterado.</p>}>
          <ul class="files">
            <For each={props.files}>
              {(f) => (
                <li>
                  <button
                    class="file"
                    classList={{ active: props.selected === f.path }}
                    title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                    onClick={() => props.onSelect(f.path)}
                  >
                    <span class={`status status-${f.status}`}>{STATUS_LETTER[f.status]}</span>
                    <span class="mono ellipsis">{f.path}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section>
        <h3>Worktrees</h3>
        <ul class="plain">
          <For each={props.project.worktrees}>
            {(w) => (
              <li class="mono small ellipsis" title={w.path}>
                {w.branch ?? "(destacado)"}
              </li>
            )}
          </For>
        </ul>
      </section>
    </aside>
  );
}
