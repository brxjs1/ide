import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";

import {
  type AutonomyMode,
  type ChatItem,
  agent,
  interrupt,
  resetConversation,
  respondPermission,
  sendPrompt,
} from "../lib/agent";

const MODES: { value: AutonomyMode; label: string; hint: string }[] = [
  { value: "plan", label: "Planejar", hint: "Só lê e propõe um plano; não altera nada." },
  { value: "assisted", label: "Assistido", hint: "Lê sozinho; pede aprovação para editar e executar." },
  { value: "autonomous", label: "Autônomo", hint: "Edita sozinho; ainda pede aprovação para comandos." },
];

export default function AgentPanel(props: { cwd: string }) {
  const [text, setText] = createSignal("");
  const [mode, setMode] = createSignal<AutonomyMode>("assisted");
  let list!: HTMLDivElement;

  createEffect(() => {
    agent.items.length;
    queueMicrotask(() => list.scrollTo({ top: list.scrollHeight }));
  });

  const submit = () => {
    const prompt = text().trim();
    if (!prompt || agent.running) return;
    setText("");
    void sendPrompt(prompt, props.cwd, mode());
  };

  return (
    <div class="agent">
      <div class="chat" ref={list}>
        <Show
          when={agent.items.length}
          fallback={
            <div class="empty muted">
              <p>Converse com o agente sobre este projeto.</p>
              <p class="small">Ex.: “analise o projeto e diga o que melhorar”, “revise antes de eu commitar”.</p>
            </div>
          }
        >
          <For each={agent.items}>{(item) => <Item item={item} />}</For>
        </Show>
        <Show when={agent.running}>
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
          rows={3}
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
            onChange={(e) => setMode(e.currentTarget.value as AutonomyMode)}
            title={MODES.find((m) => m.value === mode())?.hint}
          >
            <For each={MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
          </select>
          <span class="muted small grow">{MODES.find((m) => m.value === mode())?.hint}</span>
          <button type="button" class="ghost" disabled={!!agent.running} onClick={() => void resetConversation()}>
            Nova conversa
          </button>
          <Show
            when={agent.running}
            fallback={
              <button type="submit" class="primary" disabled={!text().trim()}>
                Enviar
              </button>
            }
          >
            <button type="button" onClick={() => void interrupt()}>
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
