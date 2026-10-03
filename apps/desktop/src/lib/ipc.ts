import { Channel, invoke } from "@tauri-apps/api/core";

// Espelha as structs serde (camelCase) de crates/core e crates/timeline.
export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
}

export interface ProjectInfo {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  worktrees: Worktree[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  staged: boolean;
  origPath: string | null;
}

export interface TimelineEvent {
  id: number;
  ts: number;
  project: string;
  kind: string;
  summary: string;
  data: unknown;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export const projectInfo = (path?: string) => invoke<ProjectInfo>("project_info", { path });

export const changedFiles = (root: string) => invoke<ChangedFile[]>("changed_files", { root });

export const fileDiff = (root: string, path: string) => invoke<string>("file_diff", { root, path });

export const timelineList = (project: string, limit = 200) =>
  invoke<TimelineEvent[]>("timeline_list", { project, limit });

export interface PtyHandlers {
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number) => void;
}

export async function ptySpawn(cwd: string, rows: number, cols: number, handlers: PtyHandlers): Promise<number> {
  // Saída chega como bytes brutos (InvokeResponseBody::Raw) — sem custo de JSON.
  const onData = new Channel<ArrayBuffer | number[]>();
  onData.onmessage = (data) => handlers.onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  const onExit = new Channel<number>();
  onExit.onmessage = handlers.onExit;
  return invoke<number>("pty_spawn", { cwd, rows, cols, onData, onExit });
}

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: number, rows: number, cols: number) => invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });

export interface Task {
  slug: string;
  branch: string;
  path: string;
  goal: string | null;
  base: string | null;
  ahead: number;
  dirty: boolean;
}

export const taskList = (root: string) => invoke<Task[]>("task_list", { root });
export const taskCreate = (root: string, slug: string, goal: string) =>
  invoke<Task>("task_create", { root, slug, goal });
export const taskDiff = (root: string, slug: string) => invoke<string>("task_diff", { root, slug });
export const taskMerge = (root: string, slug: string) => invoke<string>("task_merge", { root, slug });
export const taskDiscard = (root: string, slug: string) => invoke<void>("task_discard", { root, slug });

export interface Commit {
  hash: string;
  subject: string;
  author: string;
  /** Segundos Unix. */
  time: number;
  merge: boolean;
}

export interface Stats {
  prompts: number;
  tools: number;
  errors: number;
  terminals: number;
  tasksCreated: number;
  tasksMerged: number;
  costUsd: number;
}

export interface Brief {
  /** Meia-noite local, em ms. */
  since: number;
  commits: Commit[];
  tasks: Task[];
  changed: ChangedFile[];
  stats: Stats;
  spentToday: number;
  budgetUsd: number | null;
}

export const dailyBrief = (root: string) => invoke<Brief>("daily_brief", { root });

export type SettingKey = "budget_usd" | "sentinel_enabled" | "sentinel_idle_min" | "composer";
export const settingsGet = (key: SettingKey) => invoke<string | null>("settings_get", { key });
export const settingsSet = (key: SettingKey, value: string) => invoke<void>("settings_set", { key, value });

// Editor (crates/core::files, crates/syntax, crates/lsp).
export interface FileEntry {
  path: string;
  dir: boolean;
}

export interface CodeSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  container: string | null;
  depth: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number;
  message: string;
  source: string | null;
  /** Código do erro no servidor: "2322" (TypeScript), "E0308" (Rust)... */
  code: string | null;
}

export interface LspTarget {
  path: string | null;
  absolute: string;
  range: LspRange;
}

export const filesTree = (root: string) => invoke<FileEntry[]>("files_tree", { root });
export const fileRead = (root: string, path: string) => invoke<string>("file_read", { root, path });
export const fileWrite = (root: string, path: string, content: string) =>
  invoke<void>("file_write", { root, path, content });
export const fileOutline = (root: string, path: string) => invoke<CodeSymbol[]>("file_outline", { root, path });
export const lspOpen = (root: string, path: string, text: string) => invoke<boolean>("lsp_open", { root, path, text });
export const lspChange = (root: string, path: string, version: number, text: string) =>
  invoke<void>("lsp_change", { root, path, version, text });
export const lspSave = (root: string, path: string, text: string) =>
  invoke<void>("lsp_save", { root, path, text });
export const lspClose = (root: string, path: string) => invoke<void>("lsp_close", { root, path });
export const lspHover = (root: string, path: string, line: number, character: number) =>
  invoke<string | null>("lsp_hover", { root, path, line, character });
export const lspDefinition = (root: string, path: string, line: number, character: number) =>
  invoke<LspTarget[]>("lsp_definition", { root, path, line, character });

// Qualidade de código (crates/lint) — espelha ide_lint::{Issue, Rule, ProjectReport}.
export type IssueKind = "bug" | "vulnerability" | "security-hotspot" | "code-smell";
export type IssueSeverity = "info" | "minor" | "major" | "critical" | "blocker";

export interface CodeSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface CodeFix {
  title: string;
  edits: (CodeSpan & { text: string })[];
}

export interface CodeIssue extends CodeSpan {
  rule: string;
  message: string;
  kind: IssueKind;
  severity: IssueSeverity;
  fix: CodeFix | null;
  /** Dá para ignorar com um comentário na linha anterior (não está dentro de string ou JSX). */
  suppressible: boolean;
}

export interface LintRule {
  key: string;
  name: string;
  kind: IssueKind;
  severity: IssueSeverity;
  scope: "js" | "ts" | "any";
  debtMinutes: number;
  tags: string[];
  why: string;
  fix: string;
  noncompliant: string;
  compliant: string;
}

export interface Ratings {
  maintainability: string;
  reliability: string;
  security: string;
  debtMinutes: number;
}

export interface ProjectReport {
  files: { path: string; lines: number; issues: CodeIssue[] }[];
  filesAnalyzed: number;
  lines: number;
  ratings: Ratings;
  truncated: boolean;
}

export const lintSource = (root: string, path: string, text: string) =>
  invoke<CodeIssue[]>("lint_source", { root, path, text });
export const lintProject = (root: string) => invoke<ProjectReport>("lint_project", { root });
export const lintRules = () => invoke<LintRule[]>("lint_rules");
