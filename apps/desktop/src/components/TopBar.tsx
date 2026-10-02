import { Show, createSignal } from "solid-js";

import { isRunning } from "../lib/agent";
import { reviewConversation } from "../lib/tasks";
import type { Thread } from "../lib/threads";
import Icon from "./Icons";
import { ProjectTag } from "./Sidebar";

export default function TopBar(props: {
  projectName: string;
  title: string;
  thread: Thread | null;
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
        <button class="icon-btn" onClick={() => props.onShowSidebar()} title="Mostrar barra lateral">
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

      <Show
        when={worktree()}
        fallback={
          <Show when={props.changed > 0}>
            <button class="btn ghost-border" onClick={() => props.onReviewLocal()} title="Revisão antes do commit">
              <Icon name="review" size={14} /> Revisar
              <span class="btn-count">{props.changed}</span>
            </button>
          </Show>
        }
      >
        <button class="btn ghost-border" disabled={busy()} onClick={() => props.onReviewTask()}>
          <Icon name="review" size={14} /> Revisar
        </button>
        <button class="btn ghost-border" disabled={busy()} onClick={() => props.onMerge()} title="Merge no branch atual">
          <Icon name="merge" size={14} /> Integrar
        </button>
        <button
          class="btn ghost-border"
          classList={{ danger: confirm() }}
          disabled={busy()}
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
          <Icon name="trash" size={14} /> {confirm() ? "Confirmar descarte" : "Descartar"}
        </button>
      </Show>

      <span class="topbar-sep" />
      <button
        class="icon-btn"
        classList={{ active: props.terminalOpen }}
        onClick={() => props.onTerminal()}
        title="Terminal"
      >
        <Icon name="terminal" />
      </button>
      <button
        class="icon-btn"
        classList={{ active: props.panelOpen }}
        onClick={() => props.onPanel()}
        title="Painel lateral"
      >
        <Icon name="panel" />
      </button>
    </header>
  );
}
