import { For, Show, createEffect, createSignal } from "solid-js";

import { conversation, interrupt, isRunning, lastText, sendPrompt } from "../lib/agent";
import { notify } from "../lib/banners";
import type { ProjectInfo } from "../lib/ipc";
import { parseVerdict } from "../lib/prompts";
import { sentinel, run as runSentinel } from "../lib/sentinel";
import { reviewConversation, startWorktreeThread } from "../lib/tasks";
import { SENTINEL_CONVERSATION, type Thread, createThread, titleFrom, updateThread } from "../lib/threads";
import ChatItem from "./ChatItem";
import Composer, { type ComposerValue } from "./Composer";
import Icon from "./Icons";

const VERDICT_LABEL = { pronto: "Pronto", ressalvas: "Pronto com ressalvas", "nao-pronto": "Não pronto" } as const;

export default function ThreadView(props: {
  project: ProjectInfo;
  thread: Thread | null;
  draft: ComposerValue;
  onDraft: (patch: Partial<ComposerValue>) => void;
  onCreated: (thread: Thread) => void;
}) {
  const conv = () => (props.thread ? conversation(props.thread.conversation) : null);
  const hasItems = () => (conv()?.items.length ?? 0) > 0;
  const running = () => (props.thread ? isRunning(props.thread.conversation) : false);
  const [busy, setBusy] = createSignal(false);

  const value = (): ComposerValue =>
    props.thread
      ? {
          model: props.thread.model,
          effort: props.thread.effort,
          mode: props.thread.mode,
          where: props.thread.location.kind,
        }
      : props.draft;

  const cwd = (thread: Thread) => (thread.location.kind === "worktree" ? thread.location.path : props.project.root);

  const submit = async (text: string) => {
    const thread = props.thread;
    if (thread) {
      if (thread.title === "Nova thread") updateThread(thread.id, { title: titleFrom(text) });
      else updateThread(thread.id, {});
      void sendPrompt(thread.conversation, text, cwd(thread), thread.mode, { model: thread.model, effort: thread.effort });
      return;
    }
    const draft = props.draft;
    setBusy(true);
    try {
      if (draft.where === "worktree") {
        props.onCreated(await startWorktreeThread(props.project.root, text, draft));
      } else {
        const created = createThread({
          project: props.project.root,
          location: { kind: "local" },
          title: titleFrom(text),
          model: draft.model,
          effort: draft.effort,
          mode: draft.mode,
        });
        props.onCreated(created);
        void sendPrompt(created.conversation, text, props.project.root, draft.mode, {
          model: draft.model,
          effort: draft.effort,
        });
      }
    } catch (e) {
      notify({ tone: "error", title: "Não foi possível criar a thread", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const composer = (autofocus: boolean) => (
    <Composer
      value={value()}
      onChange={(patch) => {
        if (props.thread) {
          const { where: _where, ...rest } = patch;
          updateThread(props.thread.id, rest);
        } else props.onDraft(patch);
      }}
      onSubmit={(text) => void submit(text)}
      onStop={() => props.thread && void interrupt(props.thread.conversation)}
      running={running() || busy()}
      canChooseWhere={!props.thread}
      worktreeLabel="Worktree isolado"
      branch={
        props.thread?.location.kind === "worktree" ? `task/${props.thread.location.slug}` : props.project.branch
      }
      placeholder={
        props.thread ? "Continue a conversa" : "Peça mudanças, faça perguntas ou descreva uma tarefa para um worktree"
      }
      autofocus={autofocus}
    />
  );

  return (
    <Show
      when={hasItems()}
      fallback={
        <div class="hero">
          <h1>
            O que vamos construir em <span class="underline">{props.project.name}</span>?
          </h1>
          {composer(true)}
          <p class="hero-hint">
            <kbd>Enter</kbd> envia · <kbd>Shift</kbd>+<kbd>Enter</kbd> quebra linha · escolha{" "}
            <em>Novo worktree</em> para o agente trabalhar sozinho sem tocar no seu branch
          </p>
        </div>
      }
    >
      <div class="thread">
        <Messages conversation={props.thread!.conversation} running={running()}>
          <Show when={props.thread?.location.kind === "worktree" && props.thread.location.slug}>
            {(slug) => <ReviewSection slug={slug()} />}
          </Show>
        </Messages>
        <div class="thread-composer">
          <Show
            when={!(props.thread?.settled && props.thread.location.kind === "worktree")}
            fallback={
              <p class="settled-note">
                <Icon name="check" size={14} /> Tarefa encerrada: o worktree foi integrado ou descartado. Para continuar,
                abra uma nova thread.
              </p>
            }
          >
            {composer(false)}
          </Show>
        </div>
      </div>
    </Show>
  );
}

function Messages(props: { conversation: string; running: boolean; children?: any }) {
  let list!: HTMLDivElement;
  createEffect(() => {
    conversation(props.conversation).items.length;
    queueMicrotask(() => list?.scrollTo({ top: list.scrollHeight }));
  });
  return (
    <div class="messages" ref={list}>
      <div class="messages-inner">
        <For each={conversation(props.conversation).items}>{(item) => <ChatItem item={item} />}</For>
        <Show when={props.running}>
          <p class="working">
            <span class="spinner" /> trabalhando…
          </p>
        </Show>
        {props.children}
      </div>
    </div>
  );
}

function ReviewSection(props: { slug: string }) {
  const id = () => reviewConversation(props.slug);
  const verdict = () => parseVerdict(lastText(id()));
  return (
    <Show when={conversation(id()).items.length}>
      <section class="review">
        <header class="review-head">
          <Icon name="review" />
          <span>Revisão automática</span>
          <span class="muted small">contexto limpo · roda testes · não edita</span>
          <span class="grow" />
          <Show when={isRunning(id())}>
            <span class="spinner" />
          </Show>
          <Show when={verdict()}>{(v) => <span class={`pill verdict-${v()}`}>{VERDICT_LABEL[v()]}</span>}</Show>
        </header>
        <For each={conversation(id()).items.filter((i) => i.kind !== "user")}>{(item) => <ChatItem item={item} />}</For>
      </section>
    </Show>
  );
}

/** Vista da Sentinela: só leitura, com o estado e "rodar agora". */
export function SentinelView() {
  const STATUS: Record<string, string> = {
    off: "Desligada — ative em Hoje → Sentinela",
    waiting: "Aguardando ociosidade",
    running: "Revisando…",
    clean: "Nada bloqueante",
    found: "Encontrou problemas",
    blocked: "Pausada: orçamento diário atingido",
    error: "Resposta fora do formato",
  };
  return (
    <div class="thread">
      <div class="sentinel-head">
        <Icon name="eye" size={18} />
        <div class="grow">
          <h2>Sentinela</h2>
          <p class="muted small">
            Revisa as alterações não commitadas quando você fica ocioso, procurando só bloqueantes. Esforço baixo.
          </p>
        </div>
        <span class={`pill sentinel-${sentinel.status}`}>{STATUS[sentinel.status]}</span>
        <button class="btn" disabled={sentinel.status === "running"} onClick={() => void runSentinel(true)}>
          Rodar agora
        </button>
      </div>
      <Show
        when={conversation(SENTINEL_CONVERSATION).items.length}
        fallback={<p class="empty">Nenhuma revisão ainda.</p>}
      >
        <Messages conversation={SENTINEL_CONVERSATION} running={isRunning(SENTINEL_CONVERSATION)} />
      </Show>
    </div>
  );
}
