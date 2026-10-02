// Prompts gerados pelo app. Ficam aqui para serem fáceis de ajustar e revisar.

export function taskPrompt(slug: string, goal: string, criteria: string): string {
  return `Tarefa autônoma "${slug}". Você está em um git worktree isolado (branch task/${slug}).
Pode editar e executar comandos sem pedir aprovação, mas não altere nada fora deste diretório.

Objetivo:
${goal.trim()}

Critérios de aceite:
${criteria.trim() || "(nenhum informado: defina critérios verificáveis a partir do objetivo antes de começar)"}

Como trabalhar:
1. Leia CLAUDE.md e .project/ se existirem e siga as convenções do projeto.
2. Implemente em passos pequenos. Depois de cada passo, rode os testes e checks do projeto e corrija falhas pela causa raiz — nunca desabilite ou pule testes.
3. Faça commits atômicos no padrão de commits do projeto (Conventional Commits se não houver outro).
4. Termine com o worktree limpo (tudo commitado) e responda com: o que foi feito, os comandos de verificação e o resultado, e o que ficou pendente.`;
}

export interface ReviewTarget {
  /** Descrição curta mostrada no chat. */
  label: string;
  /** Como obter o diff a revisar. */
  diffCommand: string;
  /** O revisor pode rodar testes? (modo review, só em worktree de tarefa) */
  canRunTests: boolean;
  /** Diff já calculado, para revisores que não podem executar comandos (modo plan). */
  diff?: string;
}

/** Diffs maiores que isso são cortados no prompt (o revisor ainda pode ler os arquivos). */
const MAX_INLINE_DIFF = 120_000;

export function reviewPrompt(target: ReviewTarget): string {
  const tests = target.canRunTests
    ? "Rode a suíte de testes e os checks do projeto e reporte o resultado."
    : "Você não pode executar comandos: avalie os testes lendo o código.";
  const source = target.diff
    ? `Revise as mudanças abaixo (equivalentes a \`${target.diffCommand}\`).`
    : `Revise as mudanças mostradas por \`${target.diffCommand}\`.`;
  const inline = target.diff
    ? `\n\nDiff:\n\`\`\`diff\n${truncate(target.diff)}\n\`\`\``
    : "";
  return `${source} Você não escreveu este código: procure problemas reais, não elogie.

Leia .project/conventions/code-review.md se existir e siga-o. Verifique:
- correção: casos de borda, erros ignorados, recursos não liberados, concorrência;
- segurança: comandos montados com strings, caminhos não validados, segredos em código ou log;
- testes: lógica nova ou alterada sem teste. ${tests}
- aderência a CLAUDE.md e .project/ (convenções e decisões).

Não modifique arquivos.

Responda começando exatamente com uma linha "Veredito: PRONTO", "Veredito: PRONTO COM RESSALVAS" ou "Veredito: NÃO PRONTO", seguida dos achados no formato:
🔴 arquivo:linha — problema — sugestão
🟡 arquivo:linha — problema — sugestão
⚪ arquivo:linha — problema — sugestão${inline}`;
}

function truncate(diff: string): string {
  return diff.length > MAX_INLINE_DIFF
    ? `${diff.slice(0, MAX_INLINE_DIFF)}\n… (diff cortado: ${diff.length - MAX_INLINE_DIFF} caracteres omitidos; leia os arquivos para o resto)`
    : diff;
}

export type Verdict = "pronto" | "ressalvas" | "nao-pronto";

/** Extrai o veredito da resposta do revisor. */
export function parseVerdict(text: string | null): Verdict | null {
  const match = text?.match(/Veredito:\s*(NÃO PRONTO|PRONTO COM RESSALVAS|PRONTO)/i);
  if (!match) return null;
  const v = match[1]!.toUpperCase();
  if (v.startsWith("NÃO")) return "nao-pronto";
  if (v.includes("RESSALVAS")) return "ressalvas";
  return "pronto";
}
