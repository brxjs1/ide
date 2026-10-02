import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/ipc";

// Mesmas cores do tema escuro do app (--term-bg, --fg, --accent).
const THEME = { background: "#0e0e11", foreground: "#ececf0", cursor: "#3b82f6", selectionBackground: "#1d2a44" };

/** Espera da saída "assentar" antes de avisar atividade (um comando terminou, em geral). */
const SETTLE_MS = 800;

export default function Terminal(props: { cwd: string; onSettled?: () => void }) {
  let host!: HTMLDivElement;
  const [exited, setExited] = createSignal<number | null>(null);
  let id: number | null = null;
  let term: XTerm;
  let fit: FitAddon;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    clearTimeout(settle);
    settle = setTimeout(() => props.onSettled?.(), SETTLE_MS);
  };

  const start = async () => {
    setExited(null);
    term.reset();
    id = await ptySpawn(props.cwd, term.rows, term.cols, {
      onData: (bytes) => {
        term.write(bytes);
        activity();
      },
      onExit: (code) => {
        id = null;
        setExited(code);
        term.write(`\r\n\x1b[2m[processo encerrado: ${code}]\x1b[0m\r\n`);
      },
    }).catch((e: unknown) => {
      term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
      setExited(-1);
      return null;
    });
  };

  onMount(() => {
    term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: THEME,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.onData((data) => {
      if (id !== null) void ptyWrite(id, data);
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (id !== null) void ptyResize(id, term.rows, term.cols);
    });
    observer.observe(host);
    void start();

    onCleanup(() => {
      clearTimeout(settle);
      observer.disconnect();
      if (id !== null) void ptyKill(id);
      term.dispose();
    });
  });

  return (
    <div class="terminal">
      <div class="terminal-host" ref={host} />
      <Show when={exited() !== null}>
        <button class="terminal-restart" onClick={() => void start()}>
          Reabrir terminal
        </button>
      </Show>
    </div>
  );
}
