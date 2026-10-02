import { For, Show } from "solid-js";

import { banners, dismiss } from "../lib/banners";
import Icon from "./Icons";

export default function Banners() {
  return (
    <div class="banners" aria-live="polite">
      <For each={banners}>
        {(b) => (
          <div class={`banner tone-${b.tone}`}>
            <Icon name={b.tone === "ok" ? "check" : "info"} />
            <div class="grow">
              <div class="banner-title">{b.title}</div>
              <Show when={b.text}>
                <div class="banner-text">{b.text}</div>
              </Show>
            </div>
            <Show when={b.action}>
              {(a) => (
                <button
                  class="btn small"
                  onClick={() => {
                    a().run();
                    dismiss(b.id);
                  }}
                >
                  {a().label}
                </button>
              )}
            </Show>
            <button class="icon-btn" onClick={() => dismiss(b.id)} title="Fechar">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
