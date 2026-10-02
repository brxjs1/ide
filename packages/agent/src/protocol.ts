// Protocolo JSON lines entre o app (Rust) e o sidecar. Uma mensagem por linha.
// Espelhado em crates/agent e apps/desktop/src/lib/agent.ts.

/** Nível de autonomia escolhido na UI (ver docs/ROADMAP.md, módulo 6). */
export type AutonomyMode = "plan" | "assisted" | "autonomous";

export type Inbound =
  | { type: "prompt"; id: string; text: string; cwd: string; mode: AutonomyMode; model?: string }
  | { type: "permission_response"; id: string; allow: boolean; message?: string }
  | { type: "interrupt" }
  | { type: "reset" };

/** Eventos já simplificados para a UI, independentes do formato interno do SDK. */
export type AgentEvent =
  | { kind: "init"; model: string; cwd: string; permissionMode: string; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string };

export type Outbound =
  | { type: "ready" }
  | { type: "event"; promptId: string; event: AgentEvent }
  | { type: "permission_request"; id: string; promptId: string; toolName: string; input: unknown }
  | {
      type: "done";
      promptId: string;
      sessionId: string | null;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
      result: string | null;
    }
  | { type: "error"; promptId: string | null; message: string };
