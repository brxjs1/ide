// Protocolo JSON lines entre o app (Rust) e o sidecar. Uma mensagem por linha.
// Espelhado em crates/agent e apps/desktop/src/lib/agent.ts — mudou um, mude os três.

/**
 * Nível de autonomia escolhido na UI (ver docs/ROADMAP.md, módulo 6).
 * `full` e `review` dispensam aprovação e só são aceitos pelo app dentro de um
 * worktree de tarefa. `review` roda comandos (testes) mas não tem ferramentas de edição.
 */
export type AutonomyMode = "plan" | "assisted" | "autonomous" | "full" | "review";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Para continuar uma conversa depois que o app (e o sidecar) reiniciou. */
export interface Resume {
  sessionId: string;
  /** Último total_cost_usd da sessão, para o custo do próximo pedido sair incremental. */
  costTotal: number;
}

/**
 * Cada conversa tem sua própria sessão do SDK e roda em paralelo às outras
 * (chat principal, uma por tarefa, uma por revisão).
 */
export type Inbound =
  | {
      type: "prompt";
      conversation: string;
      id: string;
      text: string;
      cwd: string;
      mode: AutonomyMode;
      model?: string;
      effort?: Effort;
      /** Usado só se o sidecar ainda não conhece a sessão desta conversa. */
      resume?: Resume;
    }
  | { type: "permission_response"; id: string; allow: boolean; message?: string }
  | { type: "interrupt"; conversation: string }
  | { type: "reset"; conversation: string };

/** Eventos já simplificados para a UI, independentes do formato interno do SDK. */
export type AgentEvent =
  | { kind: "init"; model: string; cwd: string; permissionMode: string; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string };

export type Outbound =
  | { type: "ready" }
  | { type: "event"; conversation: string; promptId: string; event: AgentEvent }
  | {
      type: "permission_request";
      conversation: string;
      id: string;
      promptId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "done";
      conversation: string;
      promptId: string;
      sessionId: string | null;
      isError: boolean;
      /** Custo só deste pedido. */
      costUsd: number | null;
      /** Total acumulado da sessão (guardar e devolver em `resume`). */
      costTotal: number | null;
      durationMs: number | null;
      result: string | null;
    }
  | { type: "error"; conversation: string | null; promptId: string | null; message: string };
