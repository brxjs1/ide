// Avisos no topo da tela (estilo "toast" fixo, fechável).
import { createStore } from "solid-js/store";

export type BannerTone = "info" | "warn" | "error" | "ok";

export interface Banner {
  id: number;
  tone: BannerTone;
  title: string;
  text?: string;
  action?: { label: string; run: () => void };
}

const [banners, setBanners] = createStore<Banner[]>([]);
export { banners };

let next = 0;
const MAX = 3;

/** Mostra um aviso. Avisos com o mesmo título substituem o anterior. */
export function notify(banner: Omit<Banner, "id">, ttlMs?: number): number {
  const id = ++next;
  setBanners((list) => [...list.filter((b) => b.title !== banner.title), { ...banner, id }].slice(-MAX));
  if (ttlMs) setTimeout(() => dismiss(id), ttlMs);
  return id;
}

export const dismiss = (id: number) => setBanners((list) => list.filter((b) => b.id !== id));

/** Fecha avisos com este título (ex.: o erro de uma ação que depois deu certo). */
export const dismissTitle = (title: string) => setBanners((list) => list.filter((b) => b.title !== title));
