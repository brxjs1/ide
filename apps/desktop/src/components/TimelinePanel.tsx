import { listen } from "@tauri-apps/api/event";
import { For, Show, createResource, onCleanup } from "solid-js";

import { type TimelineEvent, isTauri, timelineList } from "../lib/ipc";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

export default function TimelinePanel(props: { project: string }) {
  const [events, { mutate }] = createResource(() => props.project, (p) => timelineList(p));

  if (isTauri()) {
    const unlisten = listen<TimelineEvent>("timeline://new", (e) => {
      if (e.payload.project === props.project) mutate((list) => [e.payload, ...(list ?? [])]);
    });
    onCleanup(() => void unlisten.then((fn) => fn()));
  }

  const dayLabel = (ev: TimelineEvent, i: number) => {
    const list = events() ?? [];
    const label = day.format(ev.ts);
    return i === 0 || day.format(list[i - 1]!.ts) !== label ? label : null;
  };

  return (
    <div class="timeline">
      <Show when={events()?.length} fallback={<p class="empty muted">Nada registrado ainda neste projeto.</p>}>
        <ol>
          <For each={events()}>
            {(ev, i) => (
              <>
                <Show when={dayLabel(ev, i())}>{(label) => <li class="day">{label()}</li>}</Show>
                <li class="event">
                  <span class="mono muted small">{time.format(ev.ts)}</span>
                  <span class={`kind kind-${ev.kind.split(".")[0]}`}>{ev.kind}</span>
                  <span class="ellipsis" title={ev.summary}>
                    {ev.summary}
                  </span>
                </li>
              </>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
