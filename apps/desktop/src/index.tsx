import { render } from "solid-js/web";

import App from "./App";
import { notify } from "./lib/banners";
import "./styles.css";

// Erros inesperados aparecem na tela em vez de sumir no console do WebView.
const report = (title: string, detail: unknown) => {
  const text = detail instanceof Error ? `${detail.message}${detail.stack ? `\n${detail.stack.split("\n")[1] ?? ""}` : ""}` : String(detail);
  notify({ tone: "error", title, text: text.slice(0, 400) }, 15000);
};
window.addEventListener("error", (e) => report("Erro inesperado na interface", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => report("Erro inesperado na interface", e.reason));

render(() => <App />, document.getElementById("root")!);
