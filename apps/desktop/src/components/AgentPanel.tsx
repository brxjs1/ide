import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";

import {
  type AutonomyMode,
  type ChatItem,
  conversation,
  interrupt,
  resetConversation,
  respondPermission,
  sendPrompt,
} from "../lib/agent";

export const MODE_INFO: Record<AutonomyMode, { label: string; hint: string }> = {
  plan: { label: "Planejar", hint: "Só lê e propõe um plano; não altera nada." },
  assisted: { label: "Assistido", hint: "Lê sozinho; pede aprovação para editar e executar." },
  autonomous: { label: "Autônomo", hint: "Edita sozinho; ainda pede aprovação para comandos." },
  full: { label: "Total", hint: "Sem aprovações. Só dentro do worktree desta tarefa." },
  review: { label: "Revisão", hint: "Roda testes sem aprovação, mas não pode editar arquivos." },
};

export default function AgentPanel(props: {
  conversation: string;
  cwd: string;
  modes: AutonomyMode[];
  initialMode?: AutonomyMode;
  empty?: string;
}) {
  const [text, setText] = createSignal("");
  const [mode, setMode] = createSignal<AutonomyMode>(props.initialMode ?? props.modes[0]!);
  const conv = () => conversation(props.conversation);
  const running = () => conv().running !== null;
  let list!: HTMLDivElement;

  createEffect(() => {
    conv().items.length;
    queueMicrotask(() => list.scrollTo({ top: list.scrollHeight }));
  });

  const submit = () => {
    const prompt = text().trim();
    if (!prompt || running()) return;
    setText("");
    void sendPrompt(props.conversation, prompt, props.cwd, mode());
  };

  return (
    <div class="agent">
      <div class="chat" ref={list}>
        <Show
          when={conv().items.length}
          fallback={
            <div class="empty muted">
              <p>{props.empty ?? "Converse com o agente sobre este projeto."}</p>
            </div>
          }
        >
          <For each={conv().items}>{(item) => <Item item={item} />}</For>
        </Show>
        <Show when={running()}>
          <p class="muted small working">trabalhando…</p>
        </Show>
      </div>

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text()}
          placeholder="Peça algo ao agente — Enter envia, Shift+Enter quebra linha"
          rows={2}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="composer-bar">
          <select
            value={mode()}
            disabled={props.modes.length < 2}
            onChange={(e) => setMode(e.currentTarget.value as AutonomyMode)}
          >
            <For each={props.modes}>{(m) => <option value={m}>{MODE_INFO[m].label}</option>}</For>
          </select>
          <span class="muted small grow">{MODE_INFO[mode()].hint}</span>
          <button
            type="button"
            class="ghost"
            disabled={running()}
            onClick={() => void resetConversation(props.conversation)}
          >
            Nova conversa
          </button>
          <Show
            when={running()}
            fallback={
              <button type="submit" class="primary" disabled={!text().trim()}>
                Enviar
              </button>
            }
          >
            <button type="button" onClick={() => void interrupt(props.conversation)}>
              Interromper
            </button>
          </Show>
        </div>
      </form>
    </div>
  );
}

function Item(props: { item: ChatItem }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>
        {(item) => <div class="msg user">{item().text}</div>}
      </Match>
      <Match when={props.item.kind === "init" && props.item}>
        {(item) => (
          <p class="muted small mono">
            {item().model} · {item().permissionMode}
          </p>
        )}
      </Match>
      <Match when={props.item.kind === "text" && props.item}>
        {(item) => <div class="msg assistant">{item().text}</div>}
      </Match>
      <Match when={props.item.kind === "tool" && props.item}>
        {(item) => (
          <details class="tool" classList={{ error: item().result?.isError }}>
            <summary>
              <span class="mono">{item().name}</span> <span class="muted mono ellipsis">{describe(item().input)}</span>
              <Show when={!item().result}>
                <span class="muted small"> …</span>
              </Show>
            </summary>
            <pre>{JSON.stringify(item().input, null, 2)}</pre>
            <Show when={item().result}>{(r) => <pre class="result">{r().content}</pre>}</Show>
          </details>
        )}
      </Match>
      <Match when={props.item.kind === "permission" && props.item}>
        {(item) => (
          <div class="permission" classList={{ [item().status]: true }}>
            <div>
              <strong>{item().toolName}</strong> quer executar:
              <pre>{describe(item().input) || JSON.stringify(item().input, null, 2)}</pre>
            </div>
            <Show
              when={item().status === "pending"}
              fallback={<span class="small muted">{item().status === "allowed" ? "permitido" : "negado"}</span>}
            >
              <div class="row">
                <button class="primary" onClick={() => void respondPermission(item().id, true)}>
                  Permitir
                </button>
                <button onClick={() => void respondPermission(item().id, false)}>Negar</button>
              </div>
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "done" && props.item}>
        {(item) => (
          <p class="muted small done" classList={{ error: item().isError }}>
            {item().isError ? "terminou com erro" : "concluído"}
            <Show when={item().durationMs}>{(ms) => ` em ${(ms() / 1000).toFixed(1)}s`}</Show>
            <Show when={item().costUsd}>{(c) => ` · US$ ${c().toFixed(4)}`}</Show>
          </p>
        )}
      </Match>
      <Match when={props.item.kind === "error" && props.item}>
        {(item) => <div class="msg error">{item().message}</div>}
      </Match>
    </Switch>
  );
}

/** O campo mais descritivo do input de uma ferramenta, como no resumo da timeline. */
function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "pattern", "path", "url", "description"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}
