import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { compilerDiagnostics, openFile } from "../lib/editor";
import { explain } from "../lib/explain";
import type { CodeIssue, IssueKind, LspDiagnostic } from "../lib/ipc";
import {
  KIND_LABEL,
  SEVERITY_LABEL,
  SEVERITY_RANK,
  analyzeProject,
  analyzing,
  liveIssues,
  loadRules,
  report,
  reportError,
  ruleFor,
} from "../lib/quality";
import Icon, { type IconName } from "./Icons";

type Filter = "all" | "compiler" | IssueKind;

/** Um item da lista: problema de qualidade ou diagnóstico do compilador. */
type Problem =
  | { source: "lint"; id: string; path: string; line: number; column: number; issue: CodeIssue }
  | { source: "compiler"; id: string; path: string; line: number; column: number; diagnostic: LspDiagnostic };

const KIND_ICON: Record<IssueKind, IconName> = {
  bug: "bug",
  vulnerability: "lock",
  "security-hotspot": "shield",
  "code-smell": "sparkle",
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "compiler", label: "Compilador" },
  { id: "bug", label: "Bugs" },
  { id: "vulnerability", label: "Vulnerab." },
  { id: "security-hotspot", label: "Segurança" },
  { id: "code-smell", label: "Code smells" },
];

/** Texto com `código` entre crases renderizado como código inline. */
function Rich(props: { text: string }) {
  return (
    <For each={props.text.split(/(`[^`]+`)/)}>
      {(part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code>{part.slice(1, -1)}</code> : part)}
    </For>
  );
}

/** Dívida em "2h 15min". */
function debt(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

/**
 * Painel Problemas, no espírito do SonarLint: notas A–E do projeto, problemas de
 * qualidade (crates/lint) e erros do compilador (LSP), com explicação e como corrigir.
 */
export default function ProblemsPanel(props: {
  root: string;
  version: number;
  onAskAgent: (prompt: string, title: string) => void;
}) {
  const [filter, setFilter] = createSignal<Filter>("all");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

  void loadRules();
  // Reanalisa quando o git muda (agente, terminal, salvar) — o primeiro roda já.
  createEffect(on(() => props.version, () => void analyzeProject(props.root)));

  const problems = createMemo<Problem[]>(() => {
    const byPath = new Map<string, CodeIssue[]>();
    for (const file of report()?.files ?? []) byPath.set(file.path, file.issues);
    // Arquivos abertos: vale o texto atual do editor, mesmo antes de salvar.
    for (const [path, issues] of Object.entries(liveIssues)) if (issues) byPath.set(path, issues);
    const out: Problem[] = [];
    for (const [path, issues] of byPath) {
      for (const issue of issues) {
        out.push({ source: "lint", id: `${path}:${issue.line}:${issue.column}:${issue.rule}`, path, line: issue.line, column: issue.column, issue });
      }
    }
    for (const [path, list] of Object.entries(compilerDiagnostics)) {
      for (const d of list ?? []) {
        if (d.severity > 2) continue; // só erros e avisos
        out.push({
          source: "compiler",
          id: `${path}:${d.range.start.line}:${d.range.start.character}:${d.code ?? d.message.slice(0, 20)}`,
          path,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          diagnostic: d,
        });
      }
    }
    return out;
  });

  const matches = (p: Problem, f: Filter) =>
    f === "all" || (f === "compiler" ? p.source === "compiler" : p.source === "lint" && p.issue.kind === f);
  const count = (f: Filter) => problems().filter((p) => matches(p, f)).length;

  /** Arquivos com os problemas do filtro; o compilador e os mais graves primeiro. */
  const groups = createMemo(() => {
    const rank = (p: Problem) => (p.source === "compiler" ? (p.diagnostic.severity === 1 ? 10 : 6) : SEVERITY_RANK[p.issue.severity]);
    const files = new Map<string, Problem[]>();
    for (const p of problems().filter((p) => matches(p, filter()))) files.set(p.path, [...(files.get(p.path) ?? []), p]);
    return [...files.entries()]
      .map(([path, list]) => ({ path, list: list.sort((a, b) => a.line - b.line || a.column - b.column), worst: Math.max(...list.map(rank)) }))
      .sort((a, b) => b.worst - a.worst || b.list.length - a.list.length || a.path.localeCompare(b.path));
  });

  const toggleFile = (path: string) =>
    setCollapsed((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = (p: Problem) => void openFile(p.path, { line: p.line, column: p.column });

  const ask = (p: Problem) => {
    if (p.source === "lint") {
      const rule = ruleFor(p.issue.rule);
      props.onAskAgent(
        `Corrija o problema ${p.issue.rule} em ${p.path}:${p.line}: ${p.issue.message}\n\n` +
          (rule ? `Regra: ${rule.name}. Por quê: ${rule.why}\nComo corrigir: ${rule.fix}\n\n` : "") +
          "Faça a menor mudança que resolve, mantenha o comportamento e rode os testes do projeto.",
        `Corrigir ${p.issue.rule} em ${p.path.split("/").pop()}`,
      );
    } else {
      const e = explain({ code: p.diagnostic.code, message: p.diagnostic.message, source: p.diagnostic.source });
      props.onAskAgent(
        `Corrija o erro do compilador em ${p.path}:${p.line}${p.diagnostic.code ? ` (${p.diagnostic.code})` : ""}:\n${p.diagnostic.message}\n\n` +
          (e ? `Explicação: ${e.summary}\nCaminhos de solução: ${e.fixes.join(" ")}\n\n` : "") +
          "Faça a menor mudança que resolve e confirme com o compilador/testes.",
        `Corrigir erro em ${p.path.split("/").pop()}`,
      );
    }
  };

  return (
    <div class="problems">
      <section class="quality-head">
        <Show
          when={report()}
          fallback={<p class="hint">{analyzing() ? "Analisando o projeto…" : (reportError() ?? "Sem análise ainda.")}</p>}
        >
          {(r) => (
            <>
              <div class="ratings">
                <Rating label="Manutenibilidade" value={r().ratings.maintainability} />
                <Rating label="Confiabilidade" value={r().ratings.reliability} />
                <Rating label="Segurança" value={r().ratings.security} />
              </div>
              <p class="quality-meta">
                <span>
                  Dívida <strong>{debt(r().ratings.debtMinutes)}</strong>
                </span>
                <span>
                  {r().filesAnalyzed} arquivos · {r().lines.toLocaleString("pt-BR")} linhas
                  {r().truncated ? " (limite atingido)" : ""}
                </span>
              </p>
            </>
          )}
        </Show>
        <button
          class="icon-btn"
          classList={{ spinning: analyzing() }}
          disabled={analyzing()}
          onClick={() => void analyzeProject(props.root)}
          aria-label="Analisar o projeto de novo"
          data-tip="Analisar de novo"
          data-tip-align="end"
        >
          <Icon name="refresh" size={14} />
        </button>
      </section>

      <div class="chips" role="tablist">
        <For each={FILTERS}>
          {(f) => (
            <button
              class="chip"
              classList={{ active: filter() === f.id, empty: count(f.id) === 0 && f.id !== "all" }}
              role="tab"
              aria-selected={filter() === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span class="chip-count">{count(f.id)}</span>
            </button>
          )}
        </For>
      </div>

      <Show
        when={groups().length}
        fallback={
          <div class="problems-empty">
            <Icon name="check" size={22} />
            <p>{analyzing() ? "Analisando…" : "Nenhum problema por aqui."}</p>
          </div>
        }
      >
        <div class="problem-files">
          <For each={groups()}>
            {(group) => (
              <section class="problem-file">
                <button class="problem-file-head" onClick={() => toggleFile(group.path)} aria-expanded={!collapsed().has(group.path)}>
                  <Icon name={collapsed().has(group.path) ? "chevronRight" : "chevron"} size={13} />
                  <span class="ellipsis">
                    <strong>{group.path.split("/").pop()}</strong>
                    <span class="faint"> {group.path.includes("/") ? group.path.slice(0, group.path.lastIndexOf("/")) : ""}</span>
                  </span>
                  <span class="grow" />
                  <span class="chip-count">{group.list.length}</span>
                </button>
                <Show when={!collapsed().has(group.path)}>
                  <For each={group.list}>
                    {(p) => (
                      <div class="problem" classList={{ selected: selected() === p.id }}>
                        <button
                          class="problem-row"
                          onClick={() => setSelected((s) => (s === p.id ? null : p.id))}
                          onDblClick={() => open(p)}
                        >
                          <ProblemIcon problem={p} />
                          <span class="problem-msg">
                            <Rich
                              text={
                                p.source === "lint"
                                  ? p.issue.message
                                  : (explain({ code: p.diagnostic.code, message: p.diagnostic.message, source: p.diagnostic.source })?.title ??
                                    p.diagnostic.message.split("\n")[0]!)
                              }
                            />
                          </span>
                          <span class="problem-where">
                            {p.source === "lint" ? p.issue.rule : (p.diagnostic.code ? `${/^\d+$/.test(p.diagnostic.code) ? "TS" : ""}${p.diagnostic.code}` : "")} · {p.line}
                          </span>
                        </button>
                        <Show when={selected() === p.id}>
                          <ProblemDetail problem={p} onOpen={() => open(p)} onAsk={() => ask(p)} />
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </section>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Rating(props: { label: string; value: string }) {
  return (
    <div class="rating">
      <span class={`rating-badge rating-${props.value.toLowerCase()}`}>{props.value}</span>
      <span class="rating-label">{props.label}</span>
    </div>
  );
}

function ProblemIcon(props: { problem: Problem }) {
  const p = props.problem;
  if (p.source === "compiler") {
    return (
      <span class={`problem-icon ${p.diagnostic.severity === 1 ? "sev-error" : "sev-warning"}`}>
        <Icon name={p.diagnostic.severity === 1 ? "x" : "info"} size={13} />
      </span>
    );
  }
  return (
    <span class={`problem-icon kind-${p.issue.kind} sev-${p.issue.severity}`} title={`${KIND_LABEL[p.issue.kind]} · ${SEVERITY_LABEL[p.issue.severity]}`}>
      <Icon name={KIND_ICON[p.issue.kind]} size={13} />
    </span>
  );
}

function ProblemDetail(props: { problem: Problem; onOpen: () => void; onAsk: () => void }) {
  const p = props.problem;
  const actions = (
    <div class="detail-actions">
      <button class="btn small" onClick={() => props.onOpen()}>
        <Icon name="code" size={13} /> Abrir
      </button>
      <button class="btn small" onClick={() => props.onAsk()}>
        <Icon name="sparkle" size={13} /> Pedir ao agente
      </button>
      <Show when={p.source === "lint" && p.issue.fix}>
        <span class="hint">
          Correção automática: <Rich text={p.source === "lint" ? (p.issue.fix?.title ?? "") : ""} /> (Ctrl+. no editor)
        </span>
      </Show>
    </div>
  );

  if (p.source === "compiler") {
    const e = explain({ code: p.diagnostic.code, message: p.diagnostic.message, source: p.diagnostic.source });
    return (
      <div class="problem-detail">
        <Show when={e} fallback={<pre class="detail-original">{p.diagnostic.message}</pre>}>
          {(x) => (
            <>
              <div class="detail-tags">
                <span class="tag">{x().code}</span>
                <span class="tag">{p.diagnostic.source ?? "compilador"}</span>
              </div>
              <p class="detail-summary">
                <Rich text={x().summary} />
              </p>
              <h5>Por que acontece</h5>
              <p>
                <Rich text={x().why} />
              </p>
              <h5>Como resolver</h5>
              <ul>
                <For each={x().fixes}>
                  {(fix) => (
                    <li>
                      <Rich text={fix} />
                    </li>
                  )}
                </For>
              </ul>
              <Show when={x().example}>
                {(ex) => <Example bad={ex().bad} good={ex().good} />}
              </Show>
              <details class="detail-original-wrap">
                <summary>Mensagem original</summary>
                <pre class="detail-original">{x().original}</pre>
              </details>
            </>
          )}
        </Show>
        {actions}
      </div>
    );
  }

  const rule = ruleFor(p.issue.rule);
  return (
    <div class="problem-detail">
      <Show
        when={rule}
        fallback={
          <p>
            <Rich text={p.issue.message} />
          </p>
        }
      >
        {(r) => (
          <>
            <h4>
              <Rich text={r().name} />
            </h4>
            <div class="detail-tags">
              <span class={`tag kind-${r().kind}`}>{KIND_LABEL[r().kind]}</span>
              <span class={`tag sev-${r().severity}`}>{SEVERITY_LABEL[r().severity]}</span>
              <span class="tag">{r().key}</span>
              <Show when={r().debtMinutes}>
                <span class="tag">~{r().debtMinutes} min</span>
              </Show>
              <For each={r().tags}>{(t) => <span class="tag faint">#{t}</span>}</For>
            </div>
            <h5>Por que é um problema</h5>
            <p>
              <Rich text={r().why} />
            </p>
            <h5>Como corrigir</h5>
            <p>
              <Rich text={r().fix} />
            </p>
            <Example bad={r().noncompliant} good={r().compliant} />
          </>
        )}
      </Show>
      {actions}
    </div>
  );
}

function Example(props: { bad: string; good: string }) {
  return (
    <div class="examples">
      <div class="example bad">
        <span class="example-label">Não conforme</span>
        <pre>{props.bad}</pre>
      </div>
      <div class="example good">
        <span class="example-label">Conforme</span>
        <pre>{props.good}</pre>
      </div>
    </div>
  );
}

/** Quantos problemas há agora (para o contador da aba): erros/avisos do compilador + qualidade. */
export function problemCount(): number {
  const byPath = new Map<string, number>();
  for (const file of report()?.files ?? []) byPath.set(file.path, file.issues.length);
  for (const [path, issues] of Object.entries(liveIssues)) if (issues) byPath.set(path, issues.length);
  let total = [...byPath.values()].reduce((a, b) => a + b, 0);
  for (const list of Object.values(compilerDiagnostics)) total += (list ?? []).filter((d) => d.severity <= 2).length;
  return total;
}
