import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";

import { fuzzyFilter } from "../lib/fuzzy";
import { filesTree } from "../lib/ipc";
import Icon, { type IconName } from "./Icons";

export type PaletteMode = "all" | "files";

export interface Command {
  id: string;
  group: "Ações" | "Threads";
  label: string;
  /** Texto à direita (atalho, idade da thread, branch...). */
  hint?: string;
  /** Mostrado como teclas (`kbd`) em vez de texto. */
  keys?: string[];
  icon: IconName;
  run: () => void;
}

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string;
  hint?: string;
  keys?: string[];
  icon: IconName;
  run: () => void;
}

/**
 * Paleta de comandos (Ctrl+K): ações, threads e — ao digitar ou com Ctrl+P — arquivos do
 * projeto. Setas navegam, Enter executa, Esc fecha.
 */
export default function CommandPalette(props: {
  open: boolean;
  mode: PaletteMode;
  root: string;
  commands: Command[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  // A árvore é lida ao abrir (arquivos novos do agente aparecem sem recarregar o app).
  const [files] = createResource(
    () => (props.open ? props.root : null),
    (root) => filesTree(root).catch(() => []),
  );

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setQuery("");
        setIndex(0);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  const items = createMemo<Item[]>(() => {
    const q = query();
    const fileItems = (): Item[] => {
      const all = (files() ?? []).filter((f) => !f.dir);
      return fuzzyFilter(all, q, (f) => f.path, props.mode === "files" ? 60 : 12).map((f) => {
        const slash = f.path.lastIndexOf("/");
        return {
          id: `file:${f.path}`,
          group: "Arquivos",
          label: f.path.slice(slash + 1),
          detail: slash > 0 ? f.path.slice(0, slash) : undefined,
          icon: "file" as const,
          run: () => props.onOpenFile(f.path),
        };
      });
    };
    if (props.mode === "files") return fileItems();
    const byGroup = (group: Command["group"]) =>
      fuzzyFilter(
        props.commands.filter((c) => c.group === group),
        q,
        (c) => c.label,
        group === "Threads" ? 8 : 20,
      );
    // Grupos em ordem fixa (cabeçalho único por grupo), cada um ordenado pela busca.
    // Arquivos só entram quando há consulta: a lista inteira afogaria as ações.
    const groups: Item[][] = q.trim()
      ? [byGroup("Threads"), fileItems(), byGroup("Ações")]
      : [byGroup("Ações"), byGroup("Threads")];
    return groups.flat();
  });

  createEffect(on(items, () => setIndex(0)));

  const move = (delta: number) => {
    const n = items().length;
    if (!n) return;
    setIndex((i) => (i + delta + n) % n);
    queueMicrotask(() => list?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" }));
  };

  const run = (item: Item | undefined) => {
    if (!item) return;
    props.onClose();
    item.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items()[index()]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  // Cabeçalho de grupo antes do primeiro item de cada grupo.
  const startsGroup = (i: number) => i === 0 || items()[i - 1]!.group !== items()[i]!.group;

  const onDocKey = (e: KeyboardEvent) => props.open && e.key === "Escape" && props.onClose();
  document.addEventListener("keydown", onDocKey);
  onCleanup(() => document.removeEventListener("keydown", onDocKey));

  return (
    <Show when={props.open}>
      <div class="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="palette" role="dialog" aria-label="Paleta de comandos">
          <label class="palette-input">
            <Icon name={props.mode === "files" ? "file" : "search"} size={16} />
            <input
              ref={input}
              placeholder={props.mode === "files" ? "Abrir arquivo…" : "Buscar ações, threads e arquivos…"}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKey}
              spellcheck={false}
            />
            <Show when={props.mode === "files" && files.loading}>
              <span class="spinner" />
            </Show>
          </label>
          <div class="palette-list" ref={list}>
            <For
              each={items()}
              fallback={
                <p class="palette-empty">{files.loading ? "Lendo arquivos…" : "Nada encontrado."}</p>
              }
            >
              {(item, i) => (
                <>
                  <Show when={startsGroup(i())}>
                    <div class="palette-group">{item.group}</div>
                  </Show>
                  <button
                    class="palette-item"
                    classList={{ active: i() === index() }}
                    onMouseMove={() => setIndex(i())}
                    onClick={() => run(item)}
                  >
                    <Icon name={item.icon} size={15} />
                    <span class="palette-label ellipsis">
                      {item.label}
                      <Show when={item.detail}>
                        <span class="palette-detail">{item.detail}</span>
                      </Show>
                    </span>
                    <Show when={item.keys} fallback={<span class="palette-hint">{item.hint}</span>}>
                      <span class="palette-keys">
                        <For each={item.keys}>{(k) => <kbd>{k}</kbd>}</For>
                      </span>
                    </Show>
                  </button>
                </>
              )}
            </For>
          </div>
          <footer class="palette-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navegar
            </span>
            <span>
              <kbd>Enter</kbd> abrir
            </span>
            <span>
              <kbd>Esc</kbd> fechar
            </span>
          </footer>
        </div>
      </div>
    </Show>
  );
}
