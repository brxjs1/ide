import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";

import { closeFile, editorState, modelFor, save, setActive, takeReveal } from "../lib/editor";
import { fileOutline } from "../lib/ipc";
import { monaco } from "../lib/monaco";
import Icon from "./Icons";

export default function EditorView(props: { root: string; version: number }) {
  let host!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 });
  const [confirmClose, setConfirmClose] = createSignal<string | null>(null);
  const [showOutline, setShowOutline] = createSignal(true);
  // Vista estreita (painel lateral aberto): a estrutura sai para o código ter largura.
  const [narrow, setNarrow] = createSignal(false);
  const outlineVisible = () => showOutline() && !narrow() && !!active();
  let view!: HTMLDivElement;
  const active = () => editorState.files.find((f) => f.path === editorState.active) ?? null;

  const [outline] = createResource(
    () => (editorState.active ? { path: editorState.active, v: props.version } : null),
    ({ path }) => fileOutline(props.root, path).catch(() => []),
  );

  onMount(() => {
    editor = monaco.editor.create(host, {
      theme: "ide-dark",
      automaticLayout: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      // A coluna de estrutura já dá a visão geral; o minimapa só cobriria código em telas estreitas.
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 10 },
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
      model: null,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, column: e.position.column }));
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 0) < 720));
    observer.observe(view);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => editor?.dispose());

  // Troca de aba: troca o modelo e aplica uma posição pendente (vinda de "ir para definição").
  createEffect(
    on(
      () => editorState.active,
      (path) => {
        if (!editor) return;
        const model = path ? modelFor(path) : null;
        editor.setModel(model);
        const at = path ? takeReveal(path) : null;
        if (model && at) {
          editor.setPosition({ lineNumber: at.line, column: at.column });
          editor.revealLineInCenter(at.line);
        }
        if (model) editor.focus();
      },
    ),
  );

  const reveal = (line: number) => {
    if (!editor) return;
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(line);
    editor.focus();
  };

  const close = (path: string, dirty: boolean) => {
    if (dirty && confirmClose() !== path) {
      setConfirmClose(path);
      setTimeout(() => setConfirmClose((p) => (p === path ? null : p)), 3000);
      return;
    }
    setConfirmClose(null);
    closeFile(path);
  };

  return (
    <div class="editor-view" ref={view}>
      <div class="editor-tabs">
        <For each={editorState.files}>
          {(file) => (
            <div
              class="editor-tab"
              classList={{ active: file.path === editorState.active }}
              title={file.path}
              onClick={() => setActive(file.path)}
              onAuxClick={(e) => e.button === 1 && close(file.path, file.dirty)}
            >
              <span class="ellipsis">{file.path.split("/").pop()}</span>
              <Show when={file.errors > 0}>
                <span class="tab-errors">{file.errors}</span>
              </Show>
              <button
                class="tab-close"
                classList={{ dirty: file.dirty, confirm: confirmClose() === file.path }}
                title={file.dirty ? "Alterações não salvas — clique de novo para descartar" : "Fechar"}
                onClick={(e) => {
                  e.stopPropagation();
                  close(file.path, file.dirty);
                }}
              >
                <span class="dot" />
                <Icon name="x" size={12} />
              </button>
            </div>
          )}
        </For>
        <span class="grow" />
        <button
          class="icon-btn"
          classList={{ active: outlineVisible() }}
          disabled={narrow()}
          title={narrow() ? "Estrutura (feche o painel lateral para ver)" : "Estrutura do arquivo"}
          onClick={() => setShowOutline((v) => !v)}
        >
          <Icon name="panel" />
        </button>
      </div>

      <div class="editor-body" classList={{ "with-outline": outlineVisible() }}>
        <div class="editor-host" ref={host} />
        <Show when={!active()}>
          <div class="editor-empty">
            <Icon name="file" size={28} />
            <p>Abra um arquivo pela aba Arquivos do painel lateral, ou clicando num caminho no chat.</p>
          </div>
        </Show>
        <Show when={outlineVisible()}>
          <aside class="outline">
            <h4>Estrutura</h4>
            <Show when={outline()?.length} fallback={<p class="hint">Sem símbolos (tree-sitter).</p>}>
              <ul>
                <For each={outline()}>
                  {(s) => (
                    <li>
                      <button
                        style={{ "padding-left": `${8 + s.depth * 12}px` }}
                        classList={{ current: cursor().line >= s.line && cursor().line <= s.endLine }}
                        onClick={() => reveal(s.line)}
                        title={`${s.kind} · linhas ${s.line}-${s.endLine}`}
                      >
                        <span class={`sym sym-${s.kind}`}>{SYMBOL_MARK[s.kind] ?? "•"}</span>
                        <span class="ellipsis">{s.name}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </aside>
        </Show>
      </div>

      <Show when={active()}>
        {(file) => (
          <footer class="editor-status">
            <span class="mono ellipsis">{file().path}</span>
            <span class="grow" />
            <Show when={file().dirty}>
              <span class="status-dirty">não salvo · Ctrl+S</span>
            </Show>
            <span>
              Ln {cursor().line}, Col {cursor().column}
            </span>
            <span>{file().language}</span>
            <span
              class={`lsp-state lsp-${file().lsp}`}
              title={
                file().lsp === "on"
                  ? "Servidor de linguagem ativo"
                  : file().lsp === "missing"
                    ? "Servidor de linguagem não instalado"
                    : "Sem servidor de linguagem"
              }
            >
              LSP
            </span>
            <span class="diag-count" classList={{ bad: file().errors > 0 }}>
              <Icon name="x" size={11} /> {file().errors} <Icon name="info" size={11} /> {file().warnings}
            </span>
          </footer>
        )}
      </Show>
    </div>
  );
}

const SYMBOL_MARK: Record<string, string> = {
  function: "ƒ",
  method: "m",
  struct: "S",
  class: "C",
  enum: "E",
  trait: "T",
  interface: "I",
  impl: "i",
  module: "M",
  type: "t",
  constant: "c",
  macro: "!",
};
