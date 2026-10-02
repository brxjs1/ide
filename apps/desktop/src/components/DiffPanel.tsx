import { For, Show, createResource } from "solid-js";

import { fileDiff } from "../lib/ipc";

export default function DiffPanel(props: {
  root: string;
  path: string | null;
  version: number;
  changed: number;
  onReview: () => void;
}) {
  const [diff] = createResource(
    () => (props.path ? { root: props.root, path: props.path, v: props.version } : null),
    ({ root, path }) => fileDiff(root, path),
  );

  return (
    <div class="diff">
      <Show when={props.changed > 0}>
        <div class="toolbar">
          <span class="muted small grow">{props.changed} arquivo(s) alterado(s) neste branch</span>
          <button onClick={() => props.onReview()}>Revisar com o agente</button>
        </div>
      </Show>
      <Show when={props.path} fallback={<p class="empty muted">Selecione um arquivo alterado na barra lateral.</p>}>
        <Show when={!diff.error} fallback={<p class="error">{String(diff.error)}</p>}>
          <DiffView text={diff() ?? ""} />
        </Show>
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
