import { Show, createSignal } from "solid-js";

import { isRunning } from "../lib/agent";
import { editorState, save } from "../lib/editor";
import { reviewConversation } from "../lib/tasks";
import type { Thread } from "../lib/threads";
import Icon from "./Icons";
import { ProjectTag } from "./Sidebar";

export default function TopBar(props: {
  projectName: string;
  title: string;
  thread: Thread | null;
  editor: boolean;
  changed: number;
  sidebarHidden: boolean;
  terminalOpen: boolean;
  panelOpen: boolean;
  onShowSidebar: () => void;
  onReviewLocal: () => void;
  onReviewTask: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onTerminal: () => void;
  onPanel: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  const worktree = () => (props.thread?.location.kind === "worktree" && !props.thread.settled ? props.thread : null);
  const busy = () =>
    !!props.thread &&
    (isRunning(props.thread.conversation) ||
      (props.thread.location.kind === "worktree" && isRunning(reviewConversation(props.thread.location.slug))));

  return (
    <header class="topbar">
      <Show when={props.sidebarHidden}>
        <button
          class="icon-btn"
          onClick={() => props.onShowSidebar()}
          aria-label="Mostrar barra lateral"
          data-tip="Mostrar barra lateral (Ctrl+B)"
          data-tip-align="start"
        >
          <Icon name="sidebar" />
        </button>
      </Show>
      <div class="crumbs">
        <ProjectTag name={props.projectName} />
        <span class="crumb-project">{props.projectName}</span>
        <span class="crumb-sep">/</span>
        <span class="crumb-title ellipsis">{props.title}</span>
      </div>
      <span class="grow" />

      <Show when={props.editor && editorState.files.find((f) => f.path === editorState.active)?.dirty}>
        <button class="btn primary" onClick={() => void save()}>
          <Icon name="check" size={14} /> Salvar
          <span class="btn-kbd">Ctrl S</span>
        </button>
      </Show>

      <Show
        when={!props.editor && worktree()}
        fallback={
          <Show when={!props.editor && props.changed > 0}>
            <button class="btn" onClick={() => props.onReviewLocal()} data-tip="Revisão antes do commit">
              <Icon name="review" size={14} /> <span class="btn-label">Revisar</span>
              <span class="btn-count">{props.changed}</span>
            </button>
          </Show>
        }
      >
        {/* Grupo segmentado: as três ações da tarefa ficam juntas. */}
        <div class="btn-group" role="group" aria-label="Ações da tarefa">
        <button class="btn" disabled={busy()} onClick={() => props.onReviewTask()} data-tip="Revisar a tarefa">
          <Icon name="review" size={14} /> <span class="btn-label">Revisar</span>
        </button>
        <button class="btn" disabled={busy()} onClick={() => props.onMerge()} data-tip="Merge no branch atual">
          <Icon name="merge" size={14} /> <span class="btn-label">Integrar</span>
        </button>
        <button
          class="btn danger-soft"
          classList={{ danger: confirm() }}
          disabled={busy()}
          data-tip={confirm() ? "Clique de novo para apagar o worktree" : "Descartar o worktree"}
          data-tip-align="end"
          onClick={() => {
            if (!confirm()) {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 4000);
              return;
            }
            setConfirm(false);
            props.onDiscard();
          }}
        >
          <Icon name="trash" size={14} />{" "}
          <span class="btn-label" classList={{ keep: confirm() }}>
            {confirm() ? "Confirmar descarte" : "Descartar"}
          </span>
        </button>
        </div>
      </Show>

      <span class="topbar-sep" />
      <button
        class="icon-btn"
        classList={{ active: props.terminalOpen }}
        onClick={() => props.onTerminal()}
        aria-label="Terminal"
        data-tip="Terminal (Ctrl+J)"
      >
        <Icon name="terminal" />
      </button>
      <button
        class="icon-btn"
        classList={{ active: props.panelOpen }}
        onClick={() => props.onPanel()}
        aria-label="Painel lateral"
        data-tip="Painel lateral"
        data-tip-align="end"
      >
        <Icon name="panel" />
      </button>
    </header>
  );
}
