import { Match, Show, Switch } from "solid-js";

import { type ChatItem as Item, respondPermission } from "../lib/agent";
import Icon from "./Icons";

export default function ChatItem(props: { item: Item }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>
        {(item) => <div class="msg user">{item().text}</div>}
      </Match>
      <Match when={props.item.kind === "init" && props.item}>
        {(item) => (
          <p class="meta-line">
            {item().model} · {item().permissionMode}
          </p>
        )}
      </Match>
      <Match when={props.item.kind === "text" && props.item}>
        {(item) => <div class="msg assistant">{item().text}</div>}
      </Match>
      <Match when={props.item.kind === "tool" && props.item}>
        {(item) => (
          <details class="tool" classList={{ error: item().result?.isError, pending: !item().result }}>
            <summary>
              <Icon name={item().name === "Bash" ? "terminal" : item().name.match(/Write|Edit/) ? "edit" : "tool"} />
              <span class="tool-name">{item().name}</span>
              <span class="tool-detail ellipsis">{describe(item().input)}</span>
              <Show when={!item().result}>
                <span class="spinner" />
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
            <div class="permission-head">
              <Icon name="shield" />
              <span>
                <strong>{item().toolName}</strong> pede permissão
              </span>
            </div>
            <pre>{describe(item().input) || JSON.stringify(item().input, null, 2)}</pre>
            <Show
              when={item().status === "pending"}
              fallback={<span class="small muted">{item().status === "allowed" ? "Permitido" : "Negado"}</span>}
            >
              <div class="row">
                <button class="btn primary" onClick={() => void respondPermission(item().id, true)}>
                  Permitir
                </button>
                <button class="btn" onClick={() => void respondPermission(item().id, false)}>
                  Negar
                </button>
              </div>
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "done" && props.item}>
        {(item) => (
          <p class="meta-line" classList={{ error: item().isError }}>
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
export function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "pattern", "path", "url", "description"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}
