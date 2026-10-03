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

  monaco.editor.defineTheme("ide-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b6b78", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" },
      { token: "string", foreground: "a5d6a7" },
      { token: "number", foreground: "f9b872" },
      { token: "type", foreground: "7fb8ff" },
    ],
    colors: {
      "editor.background": "#0b0b0d",
      "editor.foreground": "#ececf0",
      "editorLineNumber.foreground": "#4a4a54",
      "editorLineNumber.activeForeground": "#a0a0aa",
      "editor.lineHighlightBackground": "#141418",
      "editor.selectionBackground": "#1d2a44",
      "editorCursor.foreground": "#3b82f6",
      "editorWidget.background": "#17171b",
      "editorWidget.border": "#26262c",
      "editorHoverWidget.background": "#17171b",
      "editorHoverWidget.border": "#34343c",
      "editorGutter.background": "#0b0b0d",
      "scrollbarSlider.background": "#26262c80",
      "minimap.background": "#0b0b0d",
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
