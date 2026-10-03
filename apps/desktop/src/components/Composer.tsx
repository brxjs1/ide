import { For, Show, createSignal } from "solid-js";

import type { AutonomyMode, Effort } from "../lib/agent";
import Icon from "./Icons";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Baixo" },
  { id: "medium", label: "Médio" },
  { id: "high", label: "Alto" },
  { id: "xhigh", label: "Muito alto" },
  { id: "max", label: "Máximo" },
];

export const MODES: Record<AutonomyMode, { label: string; hint: string }> = {
  plan: { label: "Planejar", hint: "Só lê e propõe; não altera nada." },
  assisted: { label: "Assistido", hint: "Pede aprovação para editar e executar." },
  autonomous: { label: "Autônomo", hint: "Edita sozinho; pede aprovação para comandos." },
  full: { label: "Acesso total", hint: "Sem aprovações. Só dentro do worktree." },
  review: { label: "Revisão", hint: "Roda testes, não edita." },
};

export type Where = "local" | "worktree";

export interface ComposerValue {
  model: string;
  effort: Effort;
  mode: AutonomyMode;
  where: Where;
}

export default function Composer(props: {
  value: ComposerValue;
  onChange: (patch: Partial<ComposerValue>) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
  running: boolean;
  /** Thread nova: dá para escolher entre checkout atual e novo worktree. */
  canChooseWhere: boolean;
  worktreeLabel?: string;
  branch: string | null;
  placeholder?: string;
  autofocus?: boolean;
}) {
  const [text, setText] = createSignal("");
  const modes = (): AutonomyMode[] =>
    props.value.where === "worktree" ? ["full", "autonomous", "assisted", "plan"] : ["assisted", "autonomous", "plan"];

  const submit = () => {
    const value = text().trim();
    if (!value || props.running) return;
    setText("");
    props.onSubmit(value);
  };

  return (
    <div class="composer-wrap">
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text()}
          rows={3}
          autofocus={props.autofocus}
          placeholder={props.placeholder ?? "Peça mudanças, faça perguntas ou descreva uma tarefa"}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="composer-bar">
          <label class="pick" title="Modelo">
            <span class="model-mark">✳</span>
            <select value={props.value.model} onChange={(e) => props.onChange({ model: e.currentTarget.value })}>
              <For each={MODELS}>{(m) => <option value={m.id}>{m.label}</option>}</For>
            </select>
            <Icon name="chevron" size={14} />
          </label>
          <span class="sep" />
          <label class="pick" title="Esforço de raciocínio">
            <select
              value={props.value.effort}
              onChange={(e) => props.onChange({ effort: e.currentTarget.value as Effort })}
            >
              <For each={EFFORTS}>{(e) => <option value={e.id}>{e.label}</option>}</For>
            </select>
            <Icon name="chevron" size={14} />
          </label>
          <span class="sep" />
          <label class="pick" title={MODES[props.value.mode].hint}>
            <Icon name={props.value.mode === "full" ? "unlock" : "lock"} />
            <select
              value={props.value.mode}
              onChange={(e) => props.onChange({ mode: e.currentTarget.value as AutonomyMode })}
            >
              <For each={modes()}>{(m) => <option value={m}>{MODES[m].label}</option>}</For>
            </select>
            <Icon name="chevron" size={14} />
          </label>
          <span class="grow" />
          <Show
            when={props.running}
            fallback={
              <button type="submit" class="send" disabled={!text().trim()} title="Enviar (Enter)">
                <Icon name="arrowUp" size={18} />
              </button>
            }
          >
            <button type="button" class="send stop" onClick={() => props.onStop()} title="Interromper">
              <Icon name="stop" size={16} />
            </button>
          </Show>
        </div>
      </form>
      <div class="composer-tray">
        <Show
          when={props.canChooseWhere}
          fallback={
            <span class="tray-item">
              <Icon name={props.value.where === "worktree" ? "worktree" : "folder"} size={14} />
              {props.value.where === "worktree" ? props.worktreeLabel : "Checkout atual"}
            </span>
          }
        >
          <label class="pick tray-item" title="Onde o agente trabalha">
            <Icon name={props.value.where === "worktree" ? "worktree" : "folder"} size={14} />
            <select
              value={props.value.where}
              onChange={(e) => {
                const where = e.currentTarget.value as Where;
                props.onChange({ where, mode: where === "worktree" ? "full" : "assisted" });
              }}
            >
              <option value="local">Checkout atual</option>
              <option value="worktree">Novo worktree (tarefa autônoma)</option>
            </select>
            <Icon name="chevron" size={12} />
          </label>
        </Show>
        <span class="grow" />
        <Show when={props.branch}>
          <span class="tray-item mono">
            <Icon name="branch" size={13} />
            {props.branch}
          </span>
        </Show>
      </div>
    </div>
  );
}
