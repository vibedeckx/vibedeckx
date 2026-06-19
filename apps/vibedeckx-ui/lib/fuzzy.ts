// Dependency-free fuzzy subsequence matcher for the GitHub-style file finder.
// `fuzzyScore` returns how well `query` matches `target` (a file path), or null
// when query is not a subsequence of target. Higher score = better match.
// Heuristics, GitHub-like: matches in the basename, consecutive runs, and hits
// at word/separator boundaries score higher; shorter paths win ties.

const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " "]);

export function fuzzyScore(query: string, target: string): number | null {
  // Strip whitespace from the query so "foo bar" still matches "foobar".
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return null;

  const t = target.toLowerCase();

  // First char of the basename (the segment after the final "/").
  const baseStart = target.lastIndexOf("/") + 1;

  let score = 0;
  let ti = 0;
  let prevMatch = -2; // for the consecutive-match bonus

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null; // not a subsequence

    let charScore = 1;
    if (found === prevMatch + 1) charScore += 5; // consecutive
    if (found >= baseStart) charScore += 3; // in the basename
    const prevChar = found > 0 ? target[found - 1] : "/";
    if (found === 0 || found === baseStart || BOUNDARY_CHARS.has(prevChar)) {
      charScore += 4; // word/separator boundary
    }
    score += charScore;

    prevMatch = found;
    ti = found + 1;
  }

  // Shorter paths win ties — small enough never to overturn match quality.
  score += Math.max(0, 40 - target.length) * 0.1;

  return score;
}

export interface FuzzyResult {
  path: string;
  score: number;
}

export function searchFiles(files: string[], query: string, limit: number): FuzzyResult[] {
  if (!query.trim()) return [];
  const results: FuzzyResult[] = [];
  for (const path of files) {
    const score = fuzzyScore(query, path);
    if (score !== null) results.push({ path, score });
  }
  results.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return results.slice(0, limit);
}
