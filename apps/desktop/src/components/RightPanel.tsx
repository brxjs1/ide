import { Match, Switch } from "solid-js";

import type { ChangedFile } from "../lib/ipc";
import type { Thread } from "../lib/threads";
import DiffPanel from "./DiffPanel";
import FilesPanel from "./FilesPanel";
import Icon from "./Icons";
import TimelinePanel from "./TimelinePanel";
import TodayPanel from "./TodayPanel";

export type PanelTab = "files" | "diff" | "timeline" | "today";

export default function RightPanel(props: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  root: string;
  files: ChangedFile[];
  thread: Thread | null;
  version: number;
}) {
  return (
    <aside class="right-panel surface">
      <nav class="panel-tabs">
        <button classList={{ active: props.tab === "files" }} onClick={() => props.onTab("files")}>
          Arquivos
        </button>
        <button classList={{ active: props.tab === "diff" }} onClick={() => props.onTab("diff")}>
          Alterações
          <span class="count">{props.files.length || ""}</span>
        </button>
        <button classList={{ active: props.tab === "timeline" }} onClick={() => props.onTab("timeline")}>
          Timeline
        </button>
        <button classList={{ active: props.tab === "today" }} onClick={() => props.onTab("today")}>
          Hoje
        </button>
        <span class="grow" />
        <button class="icon-btn" onClick={() => props.onClose()} title="Fechar painel">
          <Icon name="x" size={14} />
        </button>
      </nav>
      <div class="panel-body">
        <Switch>
          <Match when={props.tab === "files"}>
            <FilesPanel root={props.root} version={props.version} />
          </Match>
          <Match when={props.tab === "diff"}>
            <DiffPanel root={props.root} files={props.files} thread={props.thread} version={props.version} />
          </Match>
          <Match when={props.tab === "timeline"}>
            <TimelinePanel project={props.root} />
          </Match>
          <Match when={props.tab === "today"}>
            <TodayPanel root={props.root} version={props.version} />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
