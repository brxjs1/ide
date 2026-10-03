// Qualidade de código na interface: catálogo de regras (crates/lint), problemas do
// projeto, problemas ao vivo dos arquivos abertos e as preferências do Error Lens.
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import {
  type CodeIssue,
  type IssueKind,
  type IssueSeverity,
  type LintRule,
  type ProjectReport,
  isTauri,
  lintProject,
  lintRules,
} from "./ipc";

export const KIND_LABEL: Record<IssueKind, string> = {
  bug: "Bug",
  vulnerability: "Vulnerabilidade",
  "security-hotspot": "Ponto de segurança",
  "code-smell": "Code smell",
};

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  blocker: "Bloqueante",
  critical: "Crítica",
  major: "Maior",
  minor: "Menor",
  info: "Info",
};

export const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 0, minor: 1, major: 2, critical: 3, blocker: 4 };

// Catálogo de regras, carregado uma vez.
const [rulesMap, setRulesMap] = createSignal<Map<string, LintRule>>(new Map());
let rulesLoading: Promise<void> | null = null;
export function loadRules(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  rulesLoading ??= (async () => {
    try {
      const list = await lintRules();
      setRulesMap(new Map(list.map((r) => [r.key, r])));
    } catch {
      rulesLoading = null; // tenta de novo na próxima vez
    }
  })();
  return rulesLoading;
}
export const ruleFor = (key: string) => rulesMap().get(key) ?? null;

// Problemas ao vivo dos arquivos abertos no editor (texto atual, mesmo sem salvar).
const [live, setLive] = createStore<Record<string, CodeIssue[]>>({});
export const liveIssues = live;
export const setLiveIssues = (path: string, issues: CodeIssue[] | undefined) =>
  setLive(path, issues === undefined ? undefined! : reconcile(issues));

// Análise do projeto inteiro (arquivos em disco).
const [report, setReport] = createSignal<ProjectReport | null>(null);
const [analyzing, setAnalyzing] = createSignal(false);
const [reportError, setReportError] = createSignal<string | null>(null);
export { analyzing, report, reportError };

let analysis: Promise<void> | null = null;
export function analyzeProject(root: string): Promise<void> {
  analysis ??= (async () => {
    setAnalyzing(true);
    try {
      setReport(await lintProject(root));
      setReportError(null);
    } catch (e) {
      setReportError(String(e));
    } finally {
      setAnalyzing(false);
      analysis = null;
    }
  })();
  return analysis;
}

// Error Lens: mensagem no fim da linha, colorida pela severidade.
export type LensLevel = "all" | "warnings" | "errors";
interface LensSettings {
  enabled: boolean;
  level: LensLevel;
}
const LENS_KEY = "ide.errorLens";
function loadLens(): LensSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(LENS_KEY) ?? "null") as Partial<LensSettings> | null;
    return { enabled: saved?.enabled ?? true, level: saved?.level ?? "all" };
  } catch {
    return { enabled: true, level: "all" };
  }
}
const [lens, setLensState] = createSignal<LensSettings>(loadLens());
export { lens };
const lensWatchers = new Set<() => void>();
/** Quem desenha o Error Lens (o editor) redesenha quando as preferências mudam. */
export const watchLens = (fn: () => void) => lensWatchers.add(fn);
export function setLens(patch: Partial<LensSettings>) {
  setLensState((current) => ({ ...current, ...patch }));
  lensWatchers.forEach((fn) => fn());
  try {
    localStorage.setItem(LENS_KEY, JSON.stringify(lens()));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

// O editor pede para mostrar o painel Problemas (o App decide como).
let showProblems: () => void = () => {};
export const onShowProblems = (fn: () => void) => (showProblems = fn);
export const requestProblems = () => showProblems();
