/**
 * Busca aproximada para a paleta de comandos: as letras da consulta precisam aparecer
 * em ordem no texto. Pontua mais quem casa no começo de palavras, em sequência e cedo.
 * Devolve `null` se não casa; quanto maior, melhor.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    const boundary = at === 0 || /[\s/._\-:]/.test(t[at - 1]!);
    score += 1;
    if (at === previous + 1) score += 3;
    if (boundary) score += 5;
    score -= Math.min(at - from, 6) * 0.15;
    previous = at;
    from = at + 1;
  }
  // Textos curtos e casamento contíguo exato ganham um empurrão.
  if (t.includes(q)) score += 6;
  return score - t.length * 0.01;
}

/**
 * Filtra e ordena `items` pela consulta (estável para empates). Casamentos espalhados
 * demais (letras soltas pelo texto) ficam de fora: abaixo de 2 pontos por letra.
 */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const minimum = query.replace(/\s+/g, "").length * 2;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((m): m is { item: T; index: number; score: number } => m.score !== null && m.score >= minimum)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((m) => m.item);
}
