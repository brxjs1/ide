/**
 * Busca aproximada para a paleta de comandos: as letras da consulta precisam aparecer
 * em ordem no texto. Pontua mais quem casa em início de palavra (inclusive camelCase e
 * depois de `/ . _ -`), em sequência e no nome do arquivo. Devolve `null` se não casa;
 * quanto maior, melhor.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return 0;
  const slash = text.lastIndexOf("/");
  const whole = scoreIn(q, text);
  if (whole === null) return null;
  // Em caminhos, casar no nome do arquivo vale mais que casar nas pastas.
  const base = slash >= 0 ? scoreIn(q, text.slice(slash + 1)) : null;
  return Math.max(whole, base === null ? -Infinity : base + 3);
}

const SEPARATOR = /[\s/._\-:]/;

/** Melhor alinhamento das letras de `q` em `text` (programação dinâmica, O(|q|·|text|)). */
function scoreIn(q: string, text: string): number | null {
  const n = text.length;
  if (q.length > n) return null;
  const lower = text.toLowerCase();
  const bonus = new Array<number>(n);
  for (let j = 0; j < n; j++) {
    const prev = text[j - 1];
    const boundary =
      j === 0 ||
      SEPARATOR.test(prev!) ||
      (/[a-z0-9]/.test(prev!) && /[A-Z]/.test(text[j]!)) ||
      (/[a-zA-Z]/.test(prev!) && /[0-9]/.test(text[j]!));
    bonus[j] = boundary ? 5 : 0;
  }

  // row[j]: melhor pontuação com a letra atual de q casada exatamente em j.
  let row = new Array<number>(n).fill(-Infinity);
  for (let j = 0; j < n; j++) {
    if (lower[j] === q[0]) row[j] = 1 + bonus[j]! - Math.min(j, 10) * 0.1;
  }
  for (let i = 1; i < q.length; i++) {
    const next = new Array<number>(n).fill(-Infinity);
    let bestBefore = -Infinity; // max de row[k] para k < j - 1
    for (let j = 1; j < n; j++) {
      if (j >= 2) bestBefore = Math.max(bestBefore, row[j - 2]!);
      if (lower[j] !== q[i]) continue;
      const from = Math.max(row[j - 1]! + 4, bestBefore);
      if (from === -Infinity) continue;
      next[j] = from + 1 + bonus[j]!;
    }
    row = next;
  }
  const best = Math.max(...row);
  if (best === -Infinity) return null;
  // Casamento contíguo e textos curtos ganham um empurrão.
  return best + (lower.includes(q) ? 4 : 0) - n * 0.01;
}

/**
 * Filtra e ordena `items` pela consulta (estável para empates). Casamentos espalhados
 * demais (letras soltas sem fronteira nem sequência) ficam de fora.
 */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  const q = query.replace(/\s+/g, "");
  if (!q) return items.slice(0, limit);
  const minimum = q.length * 2.5;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(q, text(item)) }))
    .filter((m): m is { item: T; index: number; score: number } => m.score !== null && m.score >= minimum)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((m) => m.item);
}
