import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { editorState, openFile } from "../lib/editor";
import { type FileEntry, filesTree } from "../lib/ipc";
import Icon from "./Icons";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function build(entries: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const byPath = new Map<string, Node>([["", root]]);
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const parent = byPath.get(slash < 0 ? "" : e.path.slice(0, slash));
    if (!parent) continue;
    const node: Node = { name: e.path.slice(slash + 1), path: e.path, dir: e.dir, children: [] };
    parent.children.push(node);
    if (e.dir) byPath.set(e.path, node);
  }
  return root.children;
}

/** Árvore do projeto (respeita .gitignore) com filtro; clique abre no editor. */
export default function FilesPanel(props: { root: string; version: number }) {
  const [tree] = createResource(
    () => ({ root: props.root, v: props.version }),
    ({ root }) => filesTree(root),
  );
  const [filter, setFilter] = createSignal("");
  const [open, setOpen] = createSignal<Set<string>>(new Set());

  const nodes = createMemo(() => build(tree() ?? []));
  const matches = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? (tree() ?? []).filter((e) => !e.dir && e.path.toLowerCase().includes(q)).slice(0, 200) : null;
  });
  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const Row = (p: { node: Node; depth: number }) => (
    <>
      <button
        class="tree-row"
        classList={{ active: editorState.active === p.node.path }}
        style={{ "padding-left": `${10 + p.depth * 14}px` }}
        onClick={() => (p.node.dir ? toggle(p.node.path) : void openFile(p.node.path))}
        title={p.node.path}
      >
        <Show
          when={p.node.dir}
          fallback={<Icon name="file" size={13} class="tree-icon" />}
        >
          <Icon name={open().has(p.node.path) ? "chevron" : "chevronRight"} size={13} class="tree-icon" />
        </Show>
        <span class="ellipsis">{p.node.name}</span>
      </button>
      <Show when={p.node.dir && open().has(p.node.path)}>
        <For each={p.node.children}>{(child) => <Row node={child} depth={p.depth + 1} />}</For>
      </Show>
    </>
  );

  return (
    <div class="files-panel">
      <label class="files-filter">
        <Icon name="search" size={14} />
        <input placeholder="Filtrar arquivos" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
      </label>
      <Show when={!tree.error} fallback={<p class="error small">{String(tree.error)}</p>}>
        <Show
          when={matches()}
          fallback={<For each={nodes()}>{(node) => <Row node={node} depth={0} />}</For>}
        >
          {(list) => (
            <Show when={list().length} fallback={<p class="hint pad">Nenhum arquivo.</p>}>
              <For each={list()}>
                {(e) => (
                  <button class="tree-row" onClick={() => void openFile(e.path)} title={e.path}>
                    <Icon name="file" size={13} class="tree-icon" />
                    <span class="ellipsis">{e.path}</span>
                  </button>
                )}
              </For>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}
