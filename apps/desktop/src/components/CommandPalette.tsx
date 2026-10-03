import { For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";

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
 * projeto. Setas (ou Ctrl+N/Ctrl+P) navegam, Enter executa, Esc fecha e devolve o foco.
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
  // A seleção é pelo id: a lista se refaz quando threads ou o git mudam, e a escolha
  // do usuário não pode pular para outro item no meio do caminho.
  const [activeId, setActiveId] = createSignal<string | null>(null);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let returnFocus: HTMLElement | null = null;
  let ranAction = false;

  // A árvore é lida ao abrir (arquivos novos do agente aparecem sem recarregar o app).
  const [files] = createResource(
    () => (props.open ? props.root : null),
    (root) => filesTree(root),
  );

  createEffect(
    on(
      () => props.open,
      (open, wasOpen) => {
        if (open) {
          returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          ranAction = false;
          setQuery("");
          setActiveId(null);
          queueMicrotask(() => input?.focus());
        } else if (wasOpen && !ranAction) {
          // Fechou sem executar nada: o foco volta para onde estava (composer, Monaco...).
          returnFocus?.focus();
        }
      },
    ),
  );

  const items = createMemo<Item[]>(() => {
    const q = query();
    const fileItems = (): Item[] => {
      const all = (files.error ? [] : (files() ?? [])).filter((f) => !f.dir);
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

  // Nova consulta: volta para o melhor resultado.
  createEffect(on(query, () => setActiveId(null), { defer: true }));

  const index = () => {
    const id = activeId();
    const i = id ? items().findIndex((item) => item.id === id) : -1;
    return i >= 0 ? i : 0;
  };
  const active = () => items()[index()];

  const move = (delta: number) => {
    const n = items().length;
    if (!n) return;
    setActiveId(items()[(index() + delta + n) % n]!.id);
    queueMicrotask(() => list?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" }));
  };

  const run = (item: Item | undefined) => {
    if (!item) return;
    ranAction = true;
    props.onClose();
    item.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (key === "arrowdown" || (ctrl && key === "n")) {
      e.preventDefault();
      move(1);
    } else if (key === "arrowup" || (ctrl && key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (key === "enter") {
      e.preventDefault();
      run(active());
    } else if (key === "escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (key === "tab") {
      // Diálogo modal: o foco não sai para os controles atrás do fundo.
      e.preventDefault();
      input?.focus();
    }
  };

  // Cabeçalho de grupo antes do primeiro item de cada grupo.
  const startsGroup = (i: number) => i === 0 || items()[i - 1]!.group !== items()[i]!.group;
  const optionId = (item: Item) => `palette-${item.id.replace(/[^\w-]/g, "_")}`;

  return (
    <Show when={props.open}>
      <div class="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" onKeyDown={onKey}>
          <label class="palette-input">
            <Icon name={props.mode === "files" ? "file" : "search"} size={16} />
            <input
              ref={input}
              role="combobox"
              aria-label={props.mode === "files" ? "Abrir arquivo" : "Buscar comandos"}
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={active() ? optionId(active()!) : undefined}
              placeholder={props.mode === "files" ? "Abrir arquivo…" : "Buscar ações, threads e arquivos…"}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              spellcheck={false}
            />
            <Show when={files.loading}>
              <span class="spinner" />
            </Show>
          </label>
          {/* mousedown sem foco: clicar na lista não tira o foco do campo (e das setas). */}
          <div
            class="palette-list"
            id="palette-list"
            role="listbox"
            ref={list}
            onMouseDown={(e) => e.preventDefault()}
          >
            <For
              each={items()}
              fallback={
                <p class="palette-empty">
                  {files.error
                    ? `Não foi possível ler os arquivos: ${String(files.error)}`
                    : files.loading
                      ? "Lendo arquivos…"
                      : "Nada encontrado."}
                </p>
              }
            >
              {(item, i) => (
                <>
                  <Show when={startsGroup(i())}>
                    <div class="palette-group" role="presentation">
                      {item.group}
                    </div>
                  </Show>
                  <button
                    id={optionId(item)}
                    class="palette-item"
                    classList={{ active: i() === index() }}
                    role="option"
                    aria-selected={i() === index()}
                    tabIndex={-1}
                    onMouseMove={() => setActiveId(item.id)}
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
              <kbd>↓</kbd> ou <kbd>Ctrl</kbd>
              <kbd>N</kbd>/<kbd>P</kbd> navegar
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
