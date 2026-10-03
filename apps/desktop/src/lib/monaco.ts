// Monaco configurado para o app: workers do Vite, tema escuro igual ao do app,
// diagnósticos do TypeScript embutido desligados (quem diagnostica é o LSP do projeto).
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
  }
}

let ready = false;

export function setupMonaco(): typeof monaco {
  if (ready) return monaco;
  ready = true;

  window.MonacoEnvironment = {
    getWorker: (_id, label) =>
      label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
  };

  // Sem os node_modules do projeto aberto, o TS embutido só geraria falsos erros.
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }

  // Mesmo preto do card principal (styles.css: --bg) e do T3 Code.
  monaco.editor.defineTheme("ide-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b6b70", fontStyle: "italic" },
      { token: "keyword", foreground: "c4b5fd" },
      { token: "string", foreground: "86efac" },
      { token: "number", foreground: "fcd34d" },
      { token: "type", foreground: "93c5fd" },
    ],
    colors: {
      "editor.background": "#0a0a0a",
      "editor.foreground": "#e8e9ed",
      "editorLineNumber.foreground": "#3f3f46",
      "editorLineNumber.activeForeground": "#a3a3a3",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#346bf140",
      "editor.inactiveSelectionBackground": "#346bf126",
      "editorCursor.foreground": "#6594fa",
      "editorIndentGuide.background1": "#ffffff0d",
      "editorIndentGuide.activeBackground1": "#ffffff26",
      "editorWidget.background": "#111112",
      "editorWidget.border": "#ffffff1a",
      "editorHoverWidget.background": "#111112",
      "editorHoverWidget.border": "#ffffff1a",
      "editorSuggestWidget.background": "#111112",
      "editorSuggestWidget.border": "#ffffff1a",
      "editorGutter.background": "#0a0a0a",
      "editorError.foreground": "#f87171",
      "editorWarning.foreground": "#fbbf24",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff1f",
      "scrollbarSlider.activeBackground": "#ffffff29",
      "widget.shadow": "#000000cc",
    },
  });
  return monaco;
}

const BY_EXTENSION: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  toml: "ini",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  sql: "sql",
};

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "plaintext";
}

/** Linguagens com servidor LSP configurado no Rust (crates/lsp::spec_for). */
export const LSP_LANGUAGES = ["rust", "typescript", "javascript", "python", "go"];

export { monaco };
