import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/ipc";

const DARK = { background: "#141417", foreground: "#e6e6ea", cursor: "#7b9cff", selectionBackground: "#3a3f55" };
const LIGHT = { background: "#ffffff", foreground: "#1d1d20", cursor: "#3b6ef5", selectionBackground: "#cdd8ff" };

export default function Terminal(props: { cwd: string }) {
  let host!: HTMLDivElement;
  const [exited, setExited] = createSignal<number | null>(null);
  let id: number | null = null;
  let term: XTerm;
  let fit: FitAddon;

  const start = async () => {
    setExited(null);
    term.reset();
    id = await ptySpawn(props.cwd, term.rows, term.cols, {
      onData: (bytes) => term.write(bytes),
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
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: dark ? DARK : LIGHT,
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
