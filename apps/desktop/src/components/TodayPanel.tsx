import { For, Show, createResource, createSignal } from "solid-js";

import { dailyBrief, settingsSet } from "../lib/ipc";
import { configure, resume, sentinel } from "../lib/sentinel";

const dayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Resumo do dia — calculado localmente, sem chamar o agente — e configurações. */
export default function TodayPanel(props: { root: string; version: number }) {
  const [refresh, setRefresh] = createSignal(0);
  const [brief] = createResource(
    () => ({ root: props.root, v: props.version, r: refresh() }),
    ({ root }) => dailyBrief(root),
  );
  const [budgetDraft, setBudgetDraft] = createSignal<string | null>(null);

  const pct = () => {
    const b = brief();
    if (!b?.budgetUsd) return 0;
    return Math.min(100, (b.spentToday / b.budgetUsd) * 100);
  };

  const saveBudget = async () => {
    const value = budgetDraft();
    if (value === null) return;
    await settingsSet("budget_usd", value.trim());
    setBudgetDraft(null);
    resume();
    setRefresh((n) => n + 1);
  };

  return (
    <div class="today">
      <Show when={brief()} fallback={<p class="empty">{brief.error ? String(brief.error) : "Carregando…"}</p>}>
        {(b) => (
          <>
            <h3 class="today-day">{capitalize(dayFmt.format(b().since))}</h3>

            <section class="card">
              <header>
                <span>Gasto do agente hoje</span>
                <strong>US$ {b().spentToday.toFixed(2)}</strong>
              </header>
              <div class="meter" classList={{ over: pct() >= 100, near: pct() >= 80 && pct() < 100 }}>
                <span style={{ width: `${pct()}%` }} />
              </div>
              <label class="inline-field">
                Orçamento diário (US$)
                <input
                  inputmode="decimal"
                  placeholder="sem limite"
                  value={budgetDraft() ?? (b().budgetUsd?.toString() ?? "")}
                  onInput={(e) => setBudgetDraft(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveBudget()}
                  onBlur={() => void saveBudget()}
                />
              </label>
              <p class="hint">Ao atingir o limite, a Sentinela pausa até amanhã. Conversas suas continuam.</p>
            </section>

            <section class="card">
              <header>
                <span>Sentinela</span>
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={sentinel.enabled}
                    onChange={(e) => void configure({ enabled: e.currentTarget.checked })}
                  />
                  <span />
                </label>
              </header>
              <label class="inline-field">
                Revisar após ociosidade de (min)
                <input
                  type="number"
                  min="1"
                  value={sentinel.idleMin}
                  onChange={(e) => void configure({ idleMin: Number(e.currentTarget.value) })}
                />
              </label>
              <p class="hint">
                <Show when={sentinel.lastRun} fallback="Ainda não rodou hoje.">
                  {(t) => `Última revisão às ${timeFmt.format(t())}.`}
                </Show>{" "}
                <Show when={sentinel.nextAt}>{(t) => `Próxima às ${timeFmt.format(t())} se nada mudar.`}</Show>
              </p>
            </section>

            <section class="card">
              <header>
                <span>Atividade</span>
              </header>
              <div class="stats">
                <Stat n={b().commits.length} label="commits" />
                <Stat n={b().stats.prompts} label="pedidos" />
                <Stat n={b().stats.tools} label="ferramentas" />
                <Stat n={b().stats.tasksMerged} label="integradas" />
                <Stat n={b().changed.length} label="alterados" />
                <Stat n={b().stats.errors} label="erros" />
              </div>
            </section>

            <section class="card">
              <header>
                <span>Tarefas abertas</span>
                <span class="muted">{b().tasks.length}</span>
              </header>
              <Show when={b().tasks.length} fallback={<p class="hint">Nenhuma.</p>}>
                <ul class="plain-list">
                  <For each={b().tasks}>
                    {(t) => (
                      <li>
                        <span class="mono">{t.slug}</span>
                        <span class="muted small">
                          {t.ahead} commit(s){t.dirty ? " · não commitado" : ""}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <section class="card">
              <header>
                <span>Commits de hoje</span>
                <span class="muted">{b().commits.length}</span>
              </header>
              <Show when={b().commits.length} fallback={<p class="hint">Nenhum commit hoje.</p>}>
                <ul class="plain-list">
                  <For each={b().commits}>
                    {(c) => (
                      <li>
                        <span class="mono muted">{timeFmt.format(c.time * 1000)}</span>
                        <span class="ellipsis" title={`${c.hash} · ${c.author}`}>
                          {c.subject}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}

/** "sexta-feira, 2 de outubro" → "Sexta-feira, 2 de outubro". */
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function Stat(props: { n: number; label: string }) {
  return (
    <div class="stat">
      <strong>{props.n}</strong>
      <span>{props.label}</span>
    </div>
  );
}
