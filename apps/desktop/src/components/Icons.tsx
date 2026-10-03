// Ícones SVG inline (traço 1.75, estilo lucide), sem dependência extra.
import type { JSX } from "solid-js";

const PATHS = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  sidebar: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM9 3v18",
  panel: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM15 3v18",
  terminal: "m4 17 6-6-6-6M12 19h8",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
  chart: "M3 3v18h18M7 16V11M12 16V7M17 16v-3",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  worktree: "M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 3v6M18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15v6",
  lock: "M5 11h14v10H5ZM8 11V7a4 4 0 1 1 8 0v4",
  unlock: "M5 11h14v10H5ZM8 11V7a4 4 0 0 1 7.75-1.4",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7Z",
  chevron: "m6 9 6 6 6-6",
  chevronUp: "m18 15-6-6-6 6",
  chevronRight: "m9 18 6-6-6-6",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  merge: "M6 3v12M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9a9 9 0 0 0 9 9",
  bug: "m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6ZM12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  file: "M14 3H6v18h12V7ZM14 3v4h4",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z",
  sparkle: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2",
  review: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon(props: { name: IconName; size?: number; class?: string; style?: JSX.CSSProperties }) {
  return (
    <svg
      class={`icon ${props.class ?? ""}`}
      style={props.style}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** Marca do app (mesmo desenho de src-tauri/icons, simplificado para tamanhos pequenos). */
export function Logo(props: { size?: number }) {
  return (
    <svg class="logo" width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="logo-spark" x1="0.2" y1="0.1" x2="0.8" y2="0.9">
          <stop offset="0" stop-color="#60a5fa" />
          <stop offset="0.55" stop-color="#3b82f6" />
          <stop offset="1" stop-color="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="32" y="32" width="960" height="960" rx="224" fill="#16161c" stroke="#ffffff22" stroke-width="16" />
      <path
        d="M332 352 196 512l136 160M692 352l136 160-136 160"
        fill="none"
        stroke="#d4d4dc"
        stroke-width="72"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M512 330c16 116 44 148 160 182-116 34-144 66-160 182-16-116-44-148-160-182 116-34 144-66 160-182Z"
        fill="url(#logo-spark)"
      />
    </svg>
  );
}
