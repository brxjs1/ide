import { Match, Show, Switch, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";

import Banners from "./components/Banners";
import CommandPalette, { type Command, type PaletteMode } from "./components/CommandPalette";
import EditorView from "./components/EditorView";
import type { ComposerValue } from "./components/Composer";
import RightPanel, { type PanelTab } from "./components/RightPanel";
import Sidebar, { type Selection } from "./components/Sidebar";
import Terminal from "./components/Terminal";
import ThreadView, { SentinelView } from "./components/ThreadView";
import TopBar from "./components/TopBar";
import { onAgentDone, onAgentError, sendPrompt } from "./lib/agent";
import { dismissTitle, notify } from "./lib/banners";
import * as editor from "./lib/editor";
import {
  type ProjectInfo,
  changedFiles,
  isTauri,
  projectInfo,
  settingsGet,
  settingsSet,
  taskDiscard,
  taskList,
  taskMerge,
} from "./lib/ipc";
import { analyzeProject, lens, onShowProblems, setLens } from "./lib/quality";
import * as sentinel from "./lib/sentinel";
import { reviewTask, reviewWorkingTree, setRoot } from "./lib/tasks";
import { adoptTasks, age, createThread, load, threadById, threads, updateThread } from "./lib/threads";

const DEFAULT_DRAFT: ComposerValue = { model: "claude-opus-5-5", effort: "high", mode: "assisted", where: "local" };

export default function App() {
  const [project] = createResource(() => (isTauri() ? projectInfo() : null));
  return (
    <Switch>
      <Match when={!isTauri()}>
        <p class="empty">
          Rodando fora do Tauri. Use <code>pnpm dev</code> na raiz.
        </p>
      </Match>
      <Match when={project.error}>
        <p class="empty error">{String(project.error)}</p>
      </Match>
      <Match when={project()}>{(p) => <Workspace initial={p()} />}</Match>
    </Switch>
  );
}

function Workspace(props: { initial: ProjectInfo }) {
  const root = props.initial.root;
  const [version, setVersion] = createSignal(0);
  const refresh = () => setVersion((v) => v + 1);

  const [project] = createResource(version, () => projectInfo(root), { initialValue: props.initial });
  const [files] = createResource(version, () => changedFiles(root), { initialValue: [] });

  const [selection, setSelection] = createSignal<Selection>({ kind: "new" });
  const [draft, setDraft] = createSignal<ComposerValue>(DEFAULT_DRAFT);
  const [sidebarHidden, setSidebarHidden] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalMounted, setTerminalMounted] = createSignal(false);
  const [panel, setPanel] = createSignal<PanelTab | null>(null);
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  const thread = () => {
    const s = selection();
    return s.kind === "thread" ? threadById(s.id) : null;
  };

  onMount(async () => {
    setRoot(root);
    editor.init(root);
    editor.onOpenRequest(() => setSelection({ kind: "editor" }));
    onShowProblems(() => setPanel("problems"));
    load(root);
    const saved = await settingsGet("composer").catch(() => null);
    if (saved) {
      try {
        const { model, effort } = JSON.parse(saved) as Partial<ComposerValue>;
        setDraft((d) => ({ ...d, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
      } catch {
        /* configuração antiga ou inválida: fica o padrão */
      }
    }
    await sentinel.init(root, { model: draft().model, open: () => setSelection({ kind: "sentinel" }) });
  });

  // Worktrees de tarefa viram threads; worktrees removidos fora do app concluem a thread.
  createEffect(
    on(version, () => {
      void taskList(root)
        .then((tasks) => adoptTasks(root, tasks, { model: draft().model, effort: draft().effort }))
        .catch(() => {});
      sentinel.activity();
      // O agente e o terminal mexem nos arquivos: recarrega abas sem edição pendente.
      void editor.reloadClean();
    }),
  );

  onCleanup(onAgentDone(refresh));
  onCleanup(
    onAgentError((conversation, message) => {
      if (message.includes("processo do agente encerrou")) {
        notify({ tone: "error", title: "O agente parou", text: message });
      } else if (thread()?.conversation !== conversation && !conversation.startsWith("watch:")) {
        notify({ tone: "error", title: "Erro em outra thread", text: message }, 8000);
      }
    }),
  );
  window.addEventListener("focus", refresh);
  onCleanup(() => window.removeEventListener("focus", refresh));

  const toggleTerminal = () => {
    setTerminalMounted(true);
    setTerminalOpen((v) => !v);
  };
  const togglePanel = (tab: PanelTab) => setPanel((current) => (current === tab ? null : tab));

  // Atalhos globais. Em captura: o Monaco e o xterm não chegam a ver Ctrl+K/P/B/J.
  const SHORTCUTS: Record<string, () => void> = {
    k: () => setPalette((p) => (p ? null : "all")),
    p: () => setPalette((p) => (p === "files" ? null : "files")),
    n: () => setSelection({ kind: "new" }),
    b: () => setSidebarHidden((v) => !v),
    j: toggleTerminal,
  };
  const onShortcut = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat || e.isComposing) return;
    // No terminal, Ctrl+B/N/P/K/J são do readline do shell (cursor, histórico, apagar linha).
    if (e.target instanceof Element && e.target.closest(".terminal-dock")) return;
    const key = e.key.toLowerCase();
    // Dentro da paleta, Ctrl+N/P navegam na lista.
    if (palette() && (key === "n" || key === "p")) return;
    const action = SHORTCUTS[key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  window.addEventListener("keydown", onShortcut, true);
  onCleanup(() => window.removeEventListener("keydown", onShortcut, true));

  const changeDraft = (patch: Partial<ComposerValue>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (patch.model || patch.effort) {
      void settingsSet("composer", JSON.stringify({ model: draft().model, effort: draft().effort }));
    }
  };

  const reviewLocal = async () => {
    let target = thread();
    if (!target || target.location.kind !== "local") {
      target = createThread({
        project: root,
        location: { kind: "local" },
        title: "Revisão antes do commit",
        model: draft().model,
        effort: draft().effort,
        mode: "plan",
      });
      setSelection({ kind: "thread", id: target.id });
    }
    await reviewWorkingTree(root, target);
  };

  const merge = async () => {
    const t = thread();
    if (t?.location.kind !== "worktree") return;
    try {
      const commit = await taskMerge(root, t.location.slug);
      await taskDiscard(root, t.location.slug);
      updateThread(t.id, { settled: true });
      dismissTitle("Não foi possível integrar");
      notify({ tone: "ok", title: `Tarefa integrada em ${commit}`, text: "O worktree foi removido." }, 8000);
      refresh();
    } catch (e) {
      notify({ tone: "error", title: "Não foi possível integrar", text: String(e) });
    }
  };

  const discard = async () => {
    const t = thread();
    if (t?.location.kind !== "worktree") return;
    try {
      await taskDiscard(root, t.location.slug);
      updateThread(t.id, { settled: true });
      notify({ tone: "info", title: "Tarefa descartada", text: `task/${t.location.slug} foi removido.` }, 6000);
      refresh();
    } catch (e) {
      notify({ tone: "error", title: "Não foi possível descartar", text: String(e) });
    }
  };

  const commands = (): Command[] => {
    const actions: Command[] = [
      { id: "new", group: "Ações", label: "Nova thread", icon: "edit", keys: ["Ctrl", "N"], run: () => setSelection({ kind: "new" }) },
      { id: "files", group: "Ações", label: "Abrir arquivo…", icon: "file", keys: ["Ctrl", "P"], run: () => queueMicrotask(() => setPalette("files")) },
      { id: "editor", group: "Ações", label: "Ir para o editor", icon: "code", run: () => setSelection({ kind: "editor" }) },
      { id: "sentinel", group: "Ações", label: "Ir para a Sentinela", icon: "eye", run: () => setSelection({ kind: "sentinel" }) },
      { id: "p-problems", group: "Ações", label: "Painel: Problemas de código", icon: "bug", run: () => togglePanel("problems") },
      {
        id: "analyze",
        group: "Ações",
        label: "Analisar a qualidade do projeto",
        icon: "shield",
        run: () => {
          setPanel("problems");
          void analyzeProject(root);
        },
      },
      {
        id: "lens",
        group: "Ações",
        label: lens().enabled ? "Error Lens: desligar" : "Error Lens: ligar",
        icon: "eye",
        run: () => setLens({ enabled: !lens().enabled }),
      },
      {
        id: "lens-level",
        group: "Ações",
        label: `Error Lens: mostrar ${lens().level === "all" ? "só erros e avisos" : lens().level === "warnings" ? "só erros" : "tudo"}`,
        icon: "eye",
        run: () => setLens({ level: lens().level === "all" ? "warnings" : lens().level === "warnings" ? "errors" : "all" }),
      },
      { id: "review", group: "Ações", label: "Revisar alterações do checkout", icon: "review", run: () => void reviewLocal() },
      { id: "terminal", group: "Ações", label: terminalOpen() ? "Esconder terminal" : "Mostrar terminal", icon: "terminal", keys: ["Ctrl", "J"], run: toggleTerminal },
      { id: "sidebar", group: "Ações", label: sidebarHidden() ? "Mostrar barra lateral" : "Esconder barra lateral", icon: "sidebar", keys: ["Ctrl", "B"], run: () => setSidebarHidden((v) => !v) },
      { id: "p-diff", group: "Ações", label: "Painel: Alterações", hint: files().length ? `${files().length} arquivo(s)` : undefined, icon: "branch", run: () => togglePanel("diff") },
      { id: "p-files", group: "Ações", label: "Painel: Arquivos", icon: "folder", run: () => togglePanel("files") },
      { id: "p-timeline", group: "Ações", label: "Painel: Timeline", icon: "clock", run: () => togglePanel("timeline") },
      { id: "p-today", group: "Ações", label: "Painel: Hoje", icon: "chart", run: () => togglePanel("today") },
      { id: "refresh", group: "Ações", label: "Atualizar estado do git", icon: "refresh", run: refresh },
    ];
    if (selection().kind === "editor" && editor.editorState.active) {
      actions.splice(1, 0, { id: "save", group: "Ações", label: "Salvar arquivo", icon: "check", keys: ["Ctrl", "S"], run: () => void editor.save() });
    }
    const list = [...threads()].sort((a, b) => Number(a.settled) - Number(b.settled) || b.updatedAt - a.updatedAt);
    return [
      ...actions,
      ...list.map<Command>((t) => ({
        id: `thread:${t.id}`,
        group: "Threads",
        label: t.title,
        hint: `${t.location.kind === "worktree" ? `task/${t.location.slug} · ` : ""}${age(t.updatedAt)}`,
        icon: t.location.kind === "worktree" ? "worktree" : "edit",
        run: () => setSelection({ kind: "thread", id: t.id }),
      })),
    ];
  };

  /** "Pedir ao agente" a partir de um problema: thread nova no checkout, com aprovação. */
  const askAgent = (prompt: string, threadTitle: string) => {
    const created = createThread({
      project: root,
      location: { kind: "local" },
      title: threadTitle,
      model: draft().model,
      effort: draft().effort,
      mode: "assisted",
    });
    setSelection({ kind: "thread", id: created.id });
    void sendPrompt(created.conversation, prompt, root, "assisted", { model: draft().model, effort: draft().effort });
  };

  const title = () => {
    const s = selection();
    if (s.kind === "sentinel") return "Sentinela";
    if (s.kind === "editor") return editor.editorState.active ?? "Editor";
    return thread()?.title ?? "Nova thread";
  };

  return (
    <div class="app" classList={{ "no-sidebar": sidebarHidden(), "with-panel": panel() !== null }}>
      <Show when={!sidebarHidden()}>
        <Sidebar
          projectName={project().name}
          threads={threads()}
          selection={selection()}
          onSelect={setSelection}
          onPanel={togglePanel}
          onPalette={() => setPalette("all")}
          onRefresh={refresh}
          onCollapse={() => setSidebarHidden(true)}
        />
      </Show>

      <main class="main surface">
        <TopBar
          projectName={project().name}
          title={title()}
          thread={thread()}
          editor={selection().kind === "editor"}
          changed={files().length}
          sidebarHidden={sidebarHidden()}
          terminalOpen={terminalOpen()}
          panelOpen={panel() !== null}
          onShowSidebar={() => setSidebarHidden(false)}
          onReviewLocal={() => void reviewLocal()}
          onReviewTask={() => thread() && void reviewTask(root, thread()!)}
          onMerge={() => void merge()}
          onDiscard={() => void discard()}
          onTerminal={toggleTerminal}
          onPanel={() => setPanel((p) => (p ? null : "diff"))}
        />
        <Banners />
        <div class="stage">
          {/* O editor fica montado: trocar de thread não perde abas, cursor nem undo. */}
          <div class="stage-pane" classList={{ hidden: selection().kind !== "editor" }}>
            <EditorView root={root} version={version()} />
          </div>
          <Switch>
            <Match when={selection().kind === "sentinel"}>
              <SentinelView />
            </Match>
            <Match when={selection().kind !== "editor"}>
              <ThreadView
                project={project()}
                thread={thread()}
                draft={draft()}
                onDraft={changeDraft}
                onCreated={(t) => setSelection({ kind: "thread", id: t.id })}
              />
            </Match>
          </Switch>
        </div>
        {/* Montado na primeira abertura e depois só escondido: o shell não morre ao fechar. */}
        <Show when={terminalMounted()}>
          <div class="terminal-dock" classList={{ hidden: !terminalOpen() }}>
            <Terminal cwd={root} onSettled={refresh} />
          </div>
        </Show>
      </main>

      <CommandPalette
        open={palette() !== null}
        mode={palette() ?? "all"}
        root={root}
        commands={palette() ? commands() : []}
        onOpenFile={(path) => void editor.openFile(path)}
        onClose={() => setPalette(null)}
      />

      <Show when={panel()}>
        {(tab) => (
          <RightPanel
            tab={tab()}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            root={root}
            files={files()}
            thread={thread()}
            version={version()}
            onAskAgent={askAgent}
          />
        )}
      </Show>
    </div>
  );
}
