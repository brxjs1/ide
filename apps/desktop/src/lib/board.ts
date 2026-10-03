// Quadro de tarefas: utilidades puras sobre o Markdown de `.project/tasks/<slug>.md`.

/** Limite do corpo da tarefa enviado ao agente. */
const MAX_BODY = 12_000;

/**
 * Corpo da tarefa para o pedido ao agente: as seções a partir do primeiro `## `,
 * sem o título nem o cabeçalho de metadados (`- Status:`, `- Worktree:`…), que
 * são do app. Sem seções, devolve o texto sem o título e os metadados.
 */
export function taskBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const firstSection = lines.findIndex((l) => l.startsWith("## "));
  const body =
    firstSection >= 0
      ? lines.slice(firstSection)
      : lines.filter((l) => !l.startsWith("# ") && !/^- [^:\n]+:/.test(l));
  const text = body.join("\n").trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n[…]` : text;
}
