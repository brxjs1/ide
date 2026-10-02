// Sentinela: agente em background com gatilhos discretos. Quando as alterações param
// de mudar e você fica ocioso por alguns minutos, ela revisa o working tree procurando
// só problemas bloqueantes. Usa esforço baixo e respeita o orçamento diário (no Rust).
import { createStore } from "solid-js/store";

import { anyRunning, lastText, onAgentDone, onAgentError, resetConversation, sendPrompt } from "./agent";
import { notify } from "./banners";
import { settingsGet, settingsSet } from "./ipc";
import { parseSentinel, sentinelPrompt } from "./prompts";
import { workingTreeDiff } from "./tasks";
import { SENTINEL_CONVERSATION } from "./threads";

export type SentinelStatus = "off" | "waiting" | "running" | "clean" | "found" | "blocked" | "error";

interface SentinelState {
  enabled: boolean;
  idleMin: number;
  status: SentinelStatus;
  findings: number;
  lastRun: number | null;
  /** Quando a próxima revisão deve rodar, se nada mudar. */
  nextAt: number | null;
}

const [state, setState] = createStore<SentinelState>({
  enabled: false,
  idleMin: 3,
  status: "off",
  findings: 0,
  lastRun: null,
  nextAt: null,
});
export const sentinel = state;

let root: string | null = null;
let model = "claude-opus-5-5";
let timer: ReturnType<typeof setTimeout> | undefined;
/** Hash do último diff revisado: não revisa o mesmo conteúdo duas vezes. */
let lastHash: string | null = null;
let openView: () => void = () => {};

export async function init(projectRoot: string, options: { model: string; open: () => void }) {
  root = projectRoot;
  model = options.model;
  openView = options.open;
  const [enabled, idle] = await Promise.all([settingsGet("sentinel_enabled"), settingsGet("sentinel_idle_min")]);
  const idleMin = Number(idle);
  setState({
    enabled: enabled === "1",
    idleMin: Number.isFinite(idleMin) && idleMin >= 1 ? idleMin : 3,
    status: enabled === "1" ? "waiting" : "off",
  });
}

export async function configure(patch: { enabled?: boolean; idleMin?: number }) {
  if (patch.enabled !== undefined) {
    setState({ enabled: patch.enabled, status: patch.enabled ? "waiting" : "off" });
    await settingsSet("sentinel_enabled", patch.enabled ? "1" : "0");
    if (patch.enabled) activity();
    else cancel();
  }
  if (patch.idleMin !== undefined && patch.idleMin >= 1) {
    setState("idleMin", patch.idleMin);
    await settingsSet("sentinel_idle_min", String(patch.idleMin));
  }
}

/** O orçamento mudou: se estava pausada, volta a observar. */
export function resume() {
  if (state.status !== "blocked") return;
  setState("status", state.enabled ? "waiting" : "off");
  activity();
}

function cancel() {
  clearTimeout(timer);
  setState("nextAt", null);
}

/**
 * Sinal de atividade (o app relê o git depois do terminal, do agente, do foco...).
 * Cada sinal reinicia a contagem de ociosidade.
 */
export function activity() {
  // Pausada pelo orçamento: espera o orçamento mudar (resume) em vez de insistir.
  if (!state.enabled || state.status === "running" || state.status === "blocked") return;
  cancel();
  const delay = state.idleMin * 60_000;
  setState("nextAt", Date.now() + delay);
  timer = setTimeout(() => void run(), delay);
}

/** Roda agora (botão "Rodar agora" ou ociosidade). */
export async function run(force = false) {
  cancel();
  if (!root || (!state.enabled && !force)) return;
  // Não disputa atenção com o que você está fazendo com o agente.
  if (anyRunning()) return activity();

  const { files, diff } = await workingTreeDiff(root);
  if (files === 0) {
    setState({ status: "clean", findings: 0, lastRun: Date.now() });
    return;
  }
  const hash = digest(diff);
  if (hash === lastHash && !force) return;
  lastHash = hash;

  setState("status", "running");
  await resetConversation(SENTINEL_CONVERSATION);
  await sendPrompt(SENTINEL_CONVERSATION, sentinelPrompt(diff), root, "plan", {
    display: `Revisar ${files} arquivo(s) alterado(s)`,
    model,
    effort: "low",
  });
}

onAgentDone((conversation, isError) => {
  if (conversation !== SENTINEL_CONVERSATION) return;
  const findings = isError ? null : parseSentinel(lastText(SENTINEL_CONVERSATION));
  if (findings === null) {
    if (state.status !== "blocked") setState({ status: "error", lastRun: Date.now() });
    return;
  }
  setState({ status: findings > 0 ? "found" : "clean", findings, lastRun: Date.now() });
  if (findings > 0) {
    notify({
      tone: "warn",
      title: `Sentinela: ${findings} problema(s) bloqueante(s)`,
      text: "Encontrados nas alterações ainda não commitadas.",
      action: { label: "Ver", run: () => openView() },
    });
  }
});

onAgentError((conversation, message) => {
  if (conversation !== SENTINEL_CONVERSATION || !message.includes("orçamento")) return;
  setState("status", "blocked");
  notify({ tone: "warn", title: "Sentinela pausada", text: message });
});

/** Hash simples (FNV-1a) — só para detectar diffs repetidos. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
