export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Above this many LCS cells the diff degrades to "all removed, all added". */
const MAX_CELLS = 250_000;

/**
 * Line diff of two texts via longest common subsequence: removed lines come
 * before the added lines that replace them. Meant for task descriptions
 * (bounded at 20k characters), not for files.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim the shared head and tail so the table only covers the changed middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const same = (lines: string[]) => lines.map((text): DiffLine => ({ kind: "same", text }));
  const middle: DiffLine[] = [];
  if (midA.length * midB.length > MAX_CELLS) {
    middle.push(...midA.map((text): DiffLine => ({ kind: "del", text })), ...midB.map((text): DiffLine => ({ kind: "add", text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j] = LCS length of midA[i:] and midB[j:]
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        middle.push({ kind: "same", text: midA[i] });
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
        middle.push({ kind: "del", text: midA[i++] });
      } else {
        middle.push({ kind: "add", text: midB[j++] });
      }
    }
  }
  return [...same(a.slice(0, head)), ...middle, ...same(a.slice(a.length - tail))];
}

/**
 * The diff with unchanged runs longer than `2 * context` folded to a marker,
 * so a one-line edit in a long description shows as a hunk, not the whole text.
 */
export function foldUnchanged(lines: DiffLine[], context = 2): Array<DiffLine | { kind: "fold"; count: number }> {
  const out: Array<DiffLine | { kind: "fold"; count: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "same") {
      out.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "same") end++;
    const run = lines.slice(i, end);
    const keepHead = i === 0 ? 0 : context;
    const keepTail = end === lines.length ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead), { kind: "fold", count: run.length - keepHead - keepTail }, ...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    i = end;
  }
  return out;
}
