import { For, Show, createEffect, createResource, createSignal } from "solid-js";

import { type ChangedFile, type FileStatus, fileDiff, taskDiff } from "../lib/ipc";
import type { Thread } from "../lib/threads";

const LETTER: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

/** Diff do branch atual (lista + arquivo) ou, numa thread de worktree, da tarefa inteira. */
export default function DiffPanel(props: { root: string; files: ChangedFile[]; thread: Thread | null; version: number }) {
  const worktree = () => (props.thread?.location.kind === "worktree" ? props.thread.location.slug : null);
  const [selected, setSelected] = createSignal<string | null>(null);

  createEffect(() => {
    const first = props.files[0]?.path ?? null;
    if (!props.files.some((f) => f.path === selected())) setSelected(first);
  });

  const [diff] = createResource(
    () => ({ slug: worktree(), path: selected(), v: props.version }),
    ({ slug, path }) => (slug ? taskDiff(props.root, slug) : path ? fileDiff(props.root, path) : Promise.resolve("")),
  );

  return (
    <div class="diff-panel">
      <Show
        when={!worktree()}
        fallback={<p class="panel-note">Tudo que a tarefa mudou desde a base (commits e pendências).</p>}
      >
        <Show when={props.files.length} fallback={<p class="empty">Nada alterado no branch atual.</p>}>
          <ul class="file-list">
            <For each={props.files}>
              {(f) => (
                <li>
                  <button
                    class="file"
                    classList={{ active: selected() === f.path }}
                    title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                    onClick={() => setSelected(f.path)}
                  >
                    <span class={`status status-${f.status}`}>{LETTER[f.status]}</span>
                    <span class="mono ellipsis">{f.path}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={!diff.error} fallback={<p class="error small">{String(diff.error)}</p>}>
        <Show when={diff()}>{(text) => <DiffView text={text()} />}</Show>
      </Show>
    </div>
  );
}

export function DiffView(props: { text: string }) {
  return (
    <pre class="diff-body">
      <For each={props.text.split("\n")}>{(line) => <div class={lineClass(line)}>{line || " "}</div>}</For>
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}
