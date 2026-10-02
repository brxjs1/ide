import { invoke } from "@tauri-apps/api/core";

// Espelha ide_core::ProjectInfo (serde camelCase).
export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
}

export interface ProjectInfo {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  worktrees: Worktree[];
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export function projectInfo(path?: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("project_info", { path });
}
