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
 * autonomous → edições automáticas; comandos ainda pedem aprovação.
 * full       → nenhuma aprovação. O app só envia este modo com cwd dentro de um
 *              worktree de tarefa (crates/core::tasks), nunca no branch do usuário.
 * review     → como full, mas sem ferramentas de edição (ver EDIT_TOOLS): o revisor
 *              roda testes sem poder "consertar" o que está revisando.
 */
export function permissionModeFor(mode: AutonomyMode): PermissionMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "assisted":
      return "default";
    case "autonomous":
      return "acceptEdits";
    case "full":
    case "review":
      return "bypassPermissions";
  }
}

/** Ferramentas removidas do contexto no modo review. */
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

interface Pending {
  conversation: string;
  promptId: string;
  resolve: (result: PermissionResult) => void;
}

interface Running {
  promptId: string;
  abort: AbortController;
  interrupt?: () => Promise<unknown>;
}

interface Conversation {
  sessionId: string | null;
  running: Running | null;
  /** Último total_cost_usd visto: o SDK acumula o custo ao retomar a sessão. */
  costTotal: number;
}

export class AgentServer {
  private conversations = new Map<string, Conversation>();
  /** Pedidos de permissão em aberto, de todas as conversas (ids são globais). */
  private pending = new Map<string, Pending>();
  private nextPermissionId = 0;
  private readonly queryFn: QueryFn;
  private readonly send: (msg: Outbound) => void;

  constructor(queryFn: QueryFn, send: (msg: Outbound) => void) {
    this.queryFn = queryFn;
    this.send = send;
  }

  /** Alguma conversa está executando? */
  get busy(): boolean {
    return [...this.conversations.values()].some((c) => c.running !== null);
  }

  isRunning(conversation: string): boolean {
    return this.conversations.get(conversation)?.running != null;
  }

  async handle(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case "prompt":
        return this.prompt(msg);
      case "permission_response":
        return this.resolvePermission(msg.id, msg.allow, msg.message);
      case "interrupt":
        return this.interrupt(msg.conversation);
      case "reset": {
        const conv = this.conversations.get(msg.conversation);
        if (conv?.running) {
          this.send({
            type: "error",
            conversation: msg.conversation,
            promptId: null,
            message: "não é possível reiniciar durante uma execução",
          });
          return;
        }
        this.conversations.delete(msg.conversation);
        return;
      }
    }
  }

  private conversation(id: string): Conversation {
    let conv = this.conversations.get(id);
    if (!conv) {
      conv = { sessionId: null, running: null, costTotal: 0 };
      this.conversations.set(id, conv);
    }
    return conv;
  }

  private async prompt(msg: Extract<Inbound, { type: "prompt" }>): Promise<void> {
    const conversation = msg.conversation;
    const conv = this.conversation(conversation);
    if (!conv.sessionId && msg.resume) {
      conv.sessionId = msg.resume.sessionId;
      conv.costTotal = msg.resume.costTotal;
    }
    if (conv.running) {
      this.send({ type: "error", conversation, promptId: msg.id, message: "esta conversa já está executando um pedido" });
      return;
    }

    const abort = new AbortController();
    const running: Running = { promptId: msg.id, abort };
    conv.running = running;
    const mode = permissionModeFor(msg.mode);

    const options: Options = {
      cwd: msg.cwd,
      abortController: abort,
      permissionMode: mode,
      ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(msg.mode === "review" ? { disallowedTools: EDIT_TOOLS } : {}),
      canUseTool: this.canUseTool(conversation, msg.id),
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      ...(conv.sessionId ? { resume: conv.sessionId } : {}),
    };

    let done = false;
    try {
      const q = this.queryFn({ prompt: msg.text, options });
      running.interrupt = () => q.interrupt();
      for await (const message of q) {
        if ("session_id" in message && typeof message.session_id === "string") {
          conv.sessionId = message.session_id;
        }
        for (const event of toEvents(message)) {
          this.send({ type: "event", conversation, promptId: msg.id, event });
        }
        if (message.type === "result") {
          done = true;
          const costUsd = incrementalCost(conv, message.total_cost_usd);
          this.send({
            type: "done",
            conversation,
            promptId: msg.id,
            sessionId: conv.sessionId,
            isError: message.is_error,
            costUsd,
            costTotal: conv.costTotal,
            durationMs: message.duration_ms,
            result: message.subtype === "success" ? message.result : message.errors.join("\n") || message.subtype,
          });
        }
      }
    } catch (err) {
      this.send({
        type: "error",
        conversation,
        promptId: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.denyPending(msg.id, "execução encerrada");
      conv.running = null;
      if (!done) {
        this.send({
          type: "done",
          conversation,
          promptId: msg.id,
          sessionId: conv.sessionId,
          isError: true,
          costUsd: null,
          costTotal: null,
          durationMs: null,
          result: null,
        });
      }
    }
  }

  private canUseTool(conversation: string, promptId: string): CanUseTool {
    return (toolName, input, { signal }) =>
      new Promise<PermissionResult>((resolve) => {
        const id = `perm-${++this.nextPermissionId}`;
        this.pending.set(id, { conversation, promptId, resolve });
        signal.addEventListener("abort", () => this.resolvePermission(id, false, "cancelado"), { once: true });
        this.send({ type: "permission_request", conversation, id, promptId, toolName, input });
      });
  }

  private resolvePermission(id: string, allow: boolean, message?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: message ?? "negado pelo usuário" });
  }

  private denyPending(promptId: string, message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.promptId === promptId) this.resolvePermission(id, false, message);
    }
  }

  private async interrupt(conversation: string): Promise<void> {
    const running = this.conversations.get(conversation)?.running;
    if (!running) return;
    this.denyPending(running.promptId, "interrompido");
    if (running.interrupt) {
      await running.interrupt().catch(() => running.abort.abort());
    } else {
      running.abort.abort();
    }
  }
}

/**
 * Custo só deste pedido. `total_cost_usd` é cumulativo dentro de uma sessão retomada
 * (o primeiro resultado já carrega os turnos anteriores); somar os totais contaria em
 * dobro. Se o total voltar a ser menor (sessão sem total salvo), ele é o próprio custo.
 */
export function incrementalCost(conv: { costTotal: number }, total: number): number {
  const cost = total >= conv.costTotal ? total - conv.costTotal : total;
  conv.costTotal = total;
  return cost;
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
