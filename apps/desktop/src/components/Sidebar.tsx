import { For, Show, createMemo, createSignal } from "solid-js";

import { isRunning, lastText, pendingPermissions } from "../lib/agent";
import { editorState } from "../lib/editor";
import { parseVerdict } from "../lib/prompts";
import { type SentinelStatus, sentinel } from "../lib/sentinel";
import { reviewConversation } from "../lib/tasks";
import { type Thread, age } from "../lib/threads";
import Icon, { Logo } from "./Icons";

export type Selection = { kind: "new" } | { kind: "thread"; id: string } | { kind: "sentinel" } | { kind: "editor" };

const SETTLED_PAGE = 10;

export default function Sidebar(props: {
  projectName: string;
  threads: Thread[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onPanel: (tab: "files" | "diff" | "timeline" | "today") => void;
  onPalette: () => void;
  onRefresh: () => void;
  onCollapse: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [settledOpen, setSettledOpen] = createSignal(true);
  const [settledLimit, setSettledLimit] = createSignal(SETTLED_PAGE);

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = [...props.threads].sort((a, b) => b.updatedAt - a.updatedAt);
    return q ? list.filter((t) => t.title.toLowerCase().includes(q)) : list;
  });
  const active = () => filtered().filter((t) => !t.settled);
  const settled = () => filtered().filter((t) => t.settled);
  const isSelected = (t: Thread) => props.selection.kind === "thread" && props.selection.id === t.id;

  return (
    <aside class="sidebar">
      <div class="brand">
        <button
          class="icon-btn"
          onClick={() => props.onCollapse()}
          aria-label="Recolher barra lateral"
          data-tip="Recolher (Ctrl+B)"
          data-tip-align="start"
        >
          <Icon name="sidebar" />
        </button>
        <Logo />
        <span>ide</span>
      </div>

      <div class="search-row">
        <label class="search">
          <Icon name="search" />
          <input placeholder="Buscar" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <button
            class="search-kbd"
            title="Paleta de comandos"
            onClick={(e) => {
              e.preventDefault();
              props.onPalette();
            }}
          >
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
        </label>
        <button
          class="icon-btn"
          classList={{ active: props.selection.kind === "new" }}
          onClick={() => props.onSelect({ kind: "new" })}
          aria-label="Nova thread"
          data-tip="Nova thread (Ctrl+N)"
          data-tip-align="end"
        >
          <Icon name="edit" />
        </button>
      </div>

      <div class="thread-scroll">
        <button
          class="sentinel-row"
          classList={{ active: props.selection.kind === "editor" }}
          onClick={() => props.onSelect({ kind: "editor" })}
        >
          <Icon name="code" />
          <span class="grow">Editor</span>
          <Show
            when={editorState.files.length}
            fallback={<span class="card-age">vazio</span>}
          >
            <span class="card-age">
              {editorState.files.length} aberto(s)
              {editorState.files.some((f) => f.dirty) ? " ·" : ""}
            </span>
            <Show when={editorState.files.some((f) => f.dirty)}>
              <span class="dot unsaved" title="Arquivos com alterações não salvas" />
            </Show>
          </Show>
        </button>
        <button
          class="sentinel-row"
          classList={{ active: props.selection.kind === "sentinel" }}
          onClick={() => props.onSelect({ kind: "sentinel" })}
        >
          <Icon name="eye" />
          <span class="grow">Sentinela</span>
          <SentinelBadge status={sentinel.status} findings={sentinel.findings} />
        </button>

        <For each={active()}>
          {(thread) => (
            <button
              class="thread-card"
              classList={{ active: isSelected(thread) }}
              onClick={() => props.onSelect({ kind: "thread", id: thread.id })}
            >
              <div class="card-top">
                <Icon name={thread.location.kind === "worktree" ? "worktree" : "edit"} size={13} class="card-kind" />
                <ProjectTag name={props.projectName} />
                <span class="card-project ellipsis">
                  {thread.location.kind === "worktree" ? `task/${thread.location.slug}` : props.projectName}
                </span>
                <span class="grow" />
                <span class="card-age">{age(thread.updatedAt)}</span>
              </div>
              <div class="card-title">{thread.title}</div>
              <ThreadBadges thread={thread} />
            </button>
          )}
        </For>
        <Show when={!active().length && !settled().length}>
          <p class="sidebar-empty">Nenhuma thread ainda. Comece pelo campo no centro.</p>
        </Show>

        <Show when={settled().length}>
          <button class="section-toggle" onClick={() => setSettledOpen((v) => !v)}>
            <span>Concluídas</span>
            <span class="rule" />
            <Icon name={settledOpen() ? "chevronUp" : "chevron"} size={14} />
          </button>
          <Show when={settledOpen()}>
            <For each={settled().slice(0, settledLimit())}>
              {(thread) => (
                <button
                  class="settled-row"
                  classList={{ active: isSelected(thread) }}
                  onClick={() => props.onSelect({ kind: "thread", id: thread.id })}
                >
                  <ProjectTag name={props.projectName} muted />
                  <span class="grow ellipsis">{thread.title}</span>
                  <span class="card-age">{age(thread.updatedAt)}</span>
                </button>
              )}
            </For>
            <Show when={settled().length > settledLimit()}>
              <button class="more-row" onClick={() => setSettledLimit((n) => n + SETTLED_PAGE)}>
                + Mostrar mais {Math.min(SETTLED_PAGE, settled().length - settledLimit())}
              </button>
            </Show>
          </Show>
        </Show>
      </div>

      <footer class="sidebar-foot">
        <button class="icon-btn" title="Hoje e configurações" onClick={() => props.onPanel("today")}>
          <Icon name="settings" />
        </button>
        <button class="icon-btn" title="Arquivos" onClick={() => props.onPanel("files")}>
          <Icon name="file" />
        </button>
        <button class="icon-btn" title="Alterações (diff)" onClick={() => props.onPanel("diff")}>
          <Icon name="branch" />
        </button>
        <button class="icon-btn" title="Timeline" onClick={() => props.onPanel("timeline")}>
          <Icon name="chart" />
        </button>
        <span class="grow" />
        <button class="icon-btn" title="Atualizar estado do git" onClick={() => props.onRefresh()}>
          <Icon name="refresh" />
        </button>
      </footer>
    </aside>
  );
}

export function ProjectTag(props: { name: string; muted?: boolean }) {
  const initials = () =>
    props.name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return <span class="project-tag" classList={{ muted: props.muted }}>{initials()}</span>;
}

function ThreadBadges(props: { thread: Thread }) {
  const waiting = () => pendingPermissions(props.thread.conversation);
  const review = () =>
    props.thread.location.kind === "worktree" ? reviewConversation(props.thread.location.slug) : null;
  const verdict = () => {
    const id = review();
    return id ? parseVerdict(lastText(id)) : null;
  };
  return (
    <Show when={isRunning(props.thread.conversation) || waiting() || (review() && isRunning(review()!)) || verdict()}>
      <div class="badges">
        <Show when={waiting()}>
          <span class="pill warn">aguarda você</span>
        </Show>
        <Show when={isRunning(props.thread.conversation) && !waiting()}>
          <span class="pill working">trabalhando</span>
        </Show>
        <Show when={review() && isRunning(review()!)}>
          <span class="pill working">revisando</span>
        </Show>
        <Show when={verdict()}>
          {(v) => (
            <span class={`pill verdict-${v()}`}>
              {v() === "pronto" ? "revisão ok" : v() === "ressalvas" ? "ressalvas" : "não pronto"}
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}

function SentinelBadge(props: { status: SentinelStatus; findings: number }) {
  return (
    <Show when={props.status !== "off"} fallback={<span class="card-age">off</span>}>
      <span class={`dot sentinel-${props.status}`} title={props.status}>
        <Show when={props.status === "found"}>{props.findings}</Show>
      </span>
    </Show>
  );
}
