import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent, AutonomyMode, Inbound, Outbound } from "./protocol.ts";

export type QueryFn = typeof sdkQuery;

/** Conteúdo de tool_result maior que isso é truncado antes de ir para a UI. */
const MAX_RESULT_CHARS = 4000;

const SYSTEM_APPEND = [
  "Você está rodando dentro do ide, o ambiente de desenvolvimento pessoal do usuário.",
  "O conhecimento do projeto está em CLAUDE.md e .project/ — siga as convenções de lá.",
].join("\n");

/**
 * plan       → só lê e planeja; nada é modificado.
 * assisted   → leituras automáticas; edições e comandos pedem aprovação na UI.
 * autonomous → edições automáticas; comandos ainda pedem aprovação. O modo sem
 *              nenhuma aprovação fica para a Fase 2, sempre dentro de um worktree.
 */
export function permissionModeFor(mode: AutonomyMode): PermissionMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "assisted":
      return "default";
    case "autonomous":
      return "acceptEdits";
  }
}

interface Pending {
  promptId: string;
  resolve: (result: PermissionResult) => void;
}

export class AgentServer {
  private sessionId: string | null = null;
  private running: { promptId: string; abort: AbortController; interrupt?: () => Promise<unknown> } | null = null;
  private pending = new Map<string, Pending>();
  private nextPermissionId = 0;
  private readonly queryFn: QueryFn;
  private readonly send: (msg: Outbound) => void;

  constructor(queryFn: QueryFn, send: (msg: Outbound) => void) {
    this.queryFn = queryFn;
    this.send = send;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async handle(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case "prompt":
        return this.prompt(msg);
      case "permission_response":
        return this.resolvePermission(msg.id, msg.allow, msg.message);
      case "interrupt":
        return this.interrupt();
      case "reset":
        if (this.running) {
          this.send({ type: "error", promptId: null, message: "não é possível reiniciar durante uma execução" });
          return;
        }
        this.sessionId = null;
        return;
    }
  }

  private async prompt(msg: Extract<Inbound, { type: "prompt" }>): Promise<void> {
    if (this.running) {
      this.send({ type: "error", promptId: msg.id, message: "o agente já está executando um pedido" });
      return;
    }

    const abort = new AbortController();
    this.running = { promptId: msg.id, abort };

    const options: Options = {
      cwd: msg.cwd,
      abortController: abort,
      permissionMode: permissionModeFor(msg.mode),
      canUseTool: this.canUseTool(msg.id),
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
      ...(msg.model ? { model: msg.model } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };

    let done = false;
    try {
      const q = this.queryFn({ prompt: msg.text, options });
      this.running.interrupt = () => q.interrupt();
      for await (const message of q) {
        if ("session_id" in message && typeof message.session_id === "string") {
          this.sessionId = message.session_id;
        }
        for (const event of toEvents(message)) {
          this.send({ type: "event", promptId: msg.id, event });
        }
        if (message.type === "result") {
          done = true;
          this.send({
            type: "done",
            promptId: msg.id,
            sessionId: this.sessionId,
            isError: message.is_error,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
            result: message.subtype === "success" ? message.result : message.errors.join("\n") || message.subtype,
          });
        }
      }
    } catch (err) {
      this.send({ type: "error", promptId: msg.id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.denyPending(msg.id, "execução encerrada");
      this.running = null;
      if (!done) {
        this.send({
          type: "done",
          promptId: msg.id,
          sessionId: this.sessionId,
          isError: true,
          costUsd: null,
          durationMs: null,
          result: null,
        });
      }
    }
  }

  private canUseTool(promptId: string): CanUseTool {
    return (toolName, input, { signal }) =>
      new Promise<PermissionResult>((resolve) => {
        const id = `perm-${++this.nextPermissionId}`;
        this.pending.set(id, { promptId, resolve });
        signal.addEventListener("abort", () => this.resolvePermission(id, false, "cancelado"), { once: true });
        this.send({ type: "permission_request", id, promptId, toolName, input });
      });
  }

  private resolvePermission(id: string, allow: boolean, message?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(
      allow ? { behavior: "allow" } : { behavior: "deny", message: message ?? "negado pelo usuário" },
    );
  }

  private denyPending(promptId: string, message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.promptId === promptId) this.resolvePermission(id, false, message);
    }
  }

  private async interrupt(): Promise<void> {
    if (!this.running) return;
    this.denyPending(this.running.promptId, "interrompido");
    if (this.running.interrupt) {
      await this.running.interrupt().catch(() => this.running?.abort.abort());
    } else {
      this.running.abort.abort();
    }
  }
}

/** Converte uma mensagem do SDK nos eventos que a UI entende. */
export function toEvents(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      if (message.subtype !== "init") return [];
      return [
        {
          kind: "init",
          model: message.model,
          cwd: message.cwd,
          permissionMode: message.permissionMode,
          sessionId: message.session_id,
        },
      ];
    case "assistant": {
      // Respostas de subagentes (parent_tool_use_id) ficam fora do chat principal.
      if (message.parent_tool_use_id) return [];
      const events: AgentEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          events.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          events.push({ kind: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      return events;
    }
    case "user": {
      if (message.parent_tool_use_id) return [];
      const content = message.message.content;
      if (typeof content === "string") return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            isError: block.is_error ?? false,
            content: truncate(stringifyContent(block.content)),
          });
        }
      }
      return events;
    }
    default:
      return [];
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "[conteúdo não textual]"))
      .join("\n");
  }
  return "";
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} caracteres omitidos)` : text;
}
