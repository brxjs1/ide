// Arquivos abertos no editor: modelos do Monaco, salvar, sincronizar com o LSP,
// diagnósticos como marcadores e navegação (ir para definição entre arquivos).
import { listen } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";

import { notify } from "./banners";
import {
  type LspDiagnostic,
  fileRead,
  fileWrite,
  isTauri,
  lspChange,
  lspClose,
  lspDefinition,
  lspHover,
  lspOpen,
  lspSave,
} from "./ipc";
import { LSP_LANGUAGES, languageFor, monaco, setupMonaco } from "./monaco";

export interface OpenFile {
  path: string;
  language: string;
  dirty: boolean;
  /** Servidor de linguagem ativo para este arquivo. */
  lsp: "off" | "on" | "missing";
  errors: number;
  warnings: number;
}

const [state, setState] = createStore<{ files: OpenFile[]; active: string | null }>({ files: [], active: null });
export const editorState = state;

let root = "";
const models = new Map<string, monaco.editor.ITextModel>();
const versions = new Map<string, number>();
const saved = new Map<string, string>();
const lspTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Aberturas em andamento (clique duplo não cria o modelo duas vezes). */
const opening = new Map<string, Promise<void>>();
/** `lspOpen` em andamento, para o fechamento esperar por ele. */
const lspOpening = new Map<string, Promise<unknown>>();
/** Modelos criados só para o "ir para definição" mostrar o destino (sem aba). */
const previews = new Map<string, monaco.editor.ITextModel>();
/** Últimos diagnósticos por arquivo, inclusive de arquivos fechados (o servidor não republica ao abrir). */
const diagnosticsByPath = new Map<string, LspDiagnostic[]>();
/** Servidores ausentes já avisados (um aviso por comando). */
const warnedMissing = new Set<string>();

type Reveal = { line: number; column: number };
let openListener: () => void = () => {};
let pendingReveal: { path: string; at: Reveal } | null = null;

/** O App troca para a vista do editor quando um arquivo é aberto de qualquer lugar. */
export const onOpenRequest = (fn: () => void) => (openListener = fn);

export const modelFor = (path: string) => models.get(path) ?? null;
export const takeReveal = (path: string) => {
  if (pendingReveal?.path !== path) return null;
  const at = pendingReveal.at;
  pendingReveal = null;
  return at;
};

const uriFor = (path: string) => monaco.Uri.file(`${root}/${path}`);
const pathOf = (uri: monaco.Uri) => {
  // Pelo Uri, não pela string da raiz: no Windows `C:\x` vira `/c:/x`.
  const prefix = `${monaco.Uri.file(root).path}/`;
  return uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : null;
};
const isOpen = (path: string) => state.files.some((f) => f.path === path);

const patch = (path: string, change: Partial<OpenFile>) =>
  setState("files", (f) => f.path === path, change);

export function init(projectRoot: string) {
  root = projectRoot;
  setupMonaco();
  registerProviders();
}

/** Abre (ou foca) um arquivo, opcionalmente posicionando o cursor (linha/coluna a partir de 1). */
export async function openFile(path: string, at?: Reveal) {
  if (at) pendingReveal = { path, at };
  if (!isOpen(path)) {
    let pending = opening.get(path);
    if (!pending) {
      pending = load(path).finally(() => opening.delete(path));
      opening.set(path, pending);
    }
    await pending;
    if (!isOpen(path)) return;
  }
  setState("active", path);
  openListener();
}

async function load(path: string) {
  let text: string;
  try {
    text = await fileRead(root, path);
  } catch (e) {
    notify({ tone: "error", title: "Não foi possível abrir o arquivo", text: `${path}: ${e}` }, 8000);
    return;
  }
  // Um modelo de pré-visualização ocupa a mesma URI: sai para dar lugar ao de verdade.
  previews.get(path)?.dispose();
  previews.delete(path);
  const language = languageFor(path);
  const model = monaco.editor.createModel(text, language, uriFor(path));
  models.set(path, model);
  saved.set(path, text);
  versions.set(path, 1);
  setState("files", (files) => [...files, { path, language, dirty: false, lsp: "off", errors: 0, warnings: 0 }]);
  const known = diagnosticsByPath.get(path);
  if (known) applyDiagnostics(path, known);
  model.onDidChangeContent(() => {
    patch(path, { dirty: model.getValue() !== saved.get(path) });
    scheduleLspChange(path);
  });
  void startLsp(path, language, text);
}

async function startLsp(path: string, language: string, text: string) {
  if (!LSP_LANGUAGES.includes(language)) return;
  const pending = lspOpen(root, path, text);
  lspOpening.set(path, pending);
  try {
    const on = await pending;
    if (!models.has(path)) return; // fechado enquanto abria (closeFile manda o didClose)
    patch(path, { lsp: on ? "on" : "off" });
    // Digitado enquanto o servidor subia: manda o texto atual.
    if (on && models.get(path)?.getValue() !== text) scheduleLspChange(path);
  } catch (e) {
    const message = String(e);
    patch(path, { lsp: "missing" });
    const command = /indisponível: (\S+)/.exec(message)?.[1] ?? message;
    if (!warnedMissing.has(command)) {
      warnedMissing.add(command);
      notify(
        { tone: "info", title: "Servidor de linguagem não encontrado", text: `${message}. O editor segue sem diagnósticos.` },
        10000,
      );
    }
  } finally {
    lspOpening.delete(path);
  }
}

function scheduleLspChange(path: string) {
  const file = state.files.find((f) => f.path === path);
  if (file?.lsp !== "on") return;
  clearTimeout(lspTimers.get(path));
  lspTimers.set(
    path,
    setTimeout(() => {
      const model = models.get(path);
      if (!model) return;
      void sendChange(path, model.getValue()).catch(() => {});
    }, 300),
  );
}

/** Versões crescentes: o Rust descarta as que chegarem fora de ordem. */
function sendChange(path: string, text: string) {
  const version = (versions.get(path) ?? 1) + 1;
  versions.set(path, version);
  return lspChange(root, path, version, text);
}

export async function save(path = state.active) {
  if (!path) return;
  const model = models.get(path);
  if (!model) return;
  const text = model.getValue();
  try {
    await fileWrite(root, path, text);
    saved.set(path, text);
    // Digitou durante a gravação: continua com alteração pendente.
    patch(path, { dirty: model.getValue() !== text });
    if (state.files.find((f) => f.path === path)?.lsp === "on") void syncSaved(path, text);
  } catch (e) {
    notify({ tone: "error", title: "Não foi possível salvar", text: `${path}: ${e}` });
  }
}

/** O texto gravado chega ao servidor antes do didSave (que dispara o check do compilador). */
async function syncSaved(path: string, text: string) {
  clearTimeout(lspTimers.get(path));
  await sendChange(path, text)
    .then(() => lspSave(root, path, text))
    .catch(() => {});
}

export function closeFile(path: string) {
  const model = models.get(path);
  model?.dispose();
  models.delete(path);
  saved.delete(path);
  versions.delete(path);
  clearTimeout(lspTimers.get(path));
  lspTimers.delete(path);
  const file = state.files.find((f) => f.path === path);
  if (file && LSP_LANGUAGES.includes(file.language)) {
    // Espera um didOpen em andamento; o Rust ignora o fechamento de quem não abriu.
    void Promise.resolve(lspOpening.get(path))
      .catch(() => {})
      .then(() => lspClose(root, path))
      .catch(() => {});
  }
  const index = state.files.findIndex((f) => f.path === path);
  setState("files", (files) => files.filter((f) => f.path !== path));
  if (state.active === path) {
    const next = state.files[Math.min(index, state.files.length - 1)];
    setState("active", next?.path ?? null);
  }
}

export const setActive = (path: string) => setState("active", path);

/** Caminho relativo ao projeto, se `path` (absoluto ou relativo) estiver dentro dele. */
export function projectPath(path: string | null): string | null {
  if (!path || !root) return null;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (path.startsWith("/") || path.includes("..")) return null;
  return path.replace(/^\.\//, "");
}

/**
 * Arquivos mudaram em disco (o agente ou o terminal editaram): recarrega os que não têm
 * alteração pendente, preservando cursor e rolagem.
 */
export async function reloadClean() {
  for (const { path, dirty } of [...state.files]) {
    if (dirty) continue;
    try {
      const text = await fileRead(root, path);
      // Rechecado depois da leitura: a aba pode ter sido fechada ou editada nesse meio-tempo.
      const model = models.get(path);
      if (!model || model.getValue() !== saved.get(path) || text === model.getValue()) continue;
      saved.set(path, text);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      patch(path, { dirty: false });
      // Mudou em disco: o servidor refaz a checagem (marcadores do compilador atualizados).
      if (state.files.find((f) => f.path === path)?.lsp === "on") void syncSaved(path, text);
    } catch {
      // Apagado ou movido: fica como está; salvar recria.
    }
  }
}

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

function applyDiagnostics(path: string, diagnostics: LspDiagnostic[]) {
  diagnosticsByPath.set(path, diagnostics);
  const model = models.get(path);
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    "lsp",
    diagnostics.map((d) => ({
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Info,
      message: d.message,
      source: d.source ?? undefined,
    })),
  );
  patch(path, {
    errors: diagnostics.filter((d) => d.severity === 1).length,
    warnings: diagnostics.filter((d) => d.severity === 2).length,
  });
}

if (isTauri()) {
  void listen<{ path: string; diagnostics: LspDiagnostic[] }>("lsp://diagnostics", (e) =>
    applyDiagnostics(e.payload.path, e.payload.diagnostics),
  );
}

let providersRegistered = false;

function registerProviders() {
  if (providersRegistered) return;
  providersRegistered = true;

  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const path = pathOf(model.uri);
        if (!path || state.files.find((f) => f.path === path)?.lsp !== "on") return null;
        const text = await lspHover(root, path, position.lineNumber - 1, position.column - 1).catch(() => null);
        return text ? { contents: [{ value: text }] } : null;
      },
    });
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        const path = pathOf(model.uri);
        if (!path || state.files.find((f) => f.path === path)?.lsp !== "on") return null;
        const targets = await lspDefinition(root, path, position.lineNumber - 1, position.column - 1).catch(() => []);
        const locations: monaco.languages.Location[] = [];
        for (const t of targets) {
          // Só dá para navegar até arquivos do projeto (bibliotecas ficam de fora).
          if (!t.path) continue;
          // O Monaco precisa de um modelo para mostrar o destino (Ctrl+hover, espiar).
          if (!models.has(t.path) && !previews.has(t.path)) {
            const text = await fileRead(root, t.path).catch(() => null);
            if (text === null || models.has(t.path) || previews.has(t.path)) continue;
            previews.set(t.path, monaco.editor.createModel(text, languageFor(t.path), uriFor(t.path)));
          }
          locations.push({
            uri: uriFor(t.path),
            range: {
              startLineNumber: t.range.start.line + 1,
              startColumn: t.range.start.character + 1,
              endLineNumber: t.range.end.line + 1,
              endColumn: t.range.end.character + 1,
            },
          });
        }
        return locations;
      },
    });
  }

  // "Ir para definição" em outro arquivo abre uma aba nossa.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selection) => {
      const path = pathOf(resource);
      if (!path) return false;
      const at =
        selection && "startLineNumber" in selection
          ? { line: selection.startLineNumber, column: selection.startColumn }
          : selection
            ? { line: selection.lineNumber, column: selection.column }
            : undefined;
      void openFile(path, at);
      return true;
    },
  });
}
