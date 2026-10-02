#!/usr/bin/env bash
# Hotspots (churn x tamanho) e acoplamento temporal a partir do histórico git.
#   scripts/hotspots.sh [desde="6 months ago"] [top=15]
set -euo pipefail

since="${1:-6 months ago}"
top="${2:-15}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

echo "== Hotspots desde '$since' (commits × linhas) =="
printf '%8s %8s %10s  %s\n' commits linhas score arquivo
git log --since="$since" --no-merges --format= --name-only \
  | grep -v '^$' | sort | uniq -c \
  | while read -r count file; do
      [[ -f "$file" ]] || continue
      lines=$(wc -l < "$file" | tr -d ' ')
      printf '%8d %8d %10d  %s\n' "$count" "$lines" "$((count * lines))" "$file"
    done \
  | sort -k3,3nr | head -n "$top"

echo
echo "== Acoplamento temporal (pares que mudam juntos, commits com ≤ 20 arquivos) =="
printf '%8s  %s\n' juntos par
git log --since="$since" --no-merges --format='format:@@' --name-only \
  | awk '
      function flush(   i, j, n) {
        n = length(files)
        if (n >= 2 && n <= 20)
          for (i = 1; i <= n; i++)
            for (j = i + 1; j <= n; j++)
              pairs[(files[i] < files[j]) ? files[i] " <-> " files[j] : files[j] " <-> " files[i]]++
        delete files
      }
      /^@@$/ { flush(); next }
      NF     { files[length(files) + 1] = $0 }
      END    { flush(); for (p in pairs) if (pairs[p] >= 2) printf "%8d  %s\n", pairs[p], p }
    ' \
  | sort -k1,1nr | head -n "$top"
