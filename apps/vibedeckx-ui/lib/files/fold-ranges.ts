// A foldable region. Both bounds are 1-based; `endLine` is inclusive and is the
// last *non-blank* line that sits deeper than the header. Collapsing the region
// hides lines `startLine + 1 .. endLine`, leaving the header (and any sibling
// closing brace at the header's indent) visible — VSCode-style.
export interface FoldRange {
  startLine: number;
  endLine: number;
}

// Leading-whitespace length, or null for a blank (whitespace-only) line. Blank
// lines carry no indent of their own and are absorbed into the enclosing region.
function indentOf(line: string): number | null {
  const match = line.match(/^[ \t]*/);
  const ws = match ? match[0].length : 0;
  if (ws === line.length) return null; // blank / whitespace-only
  return ws;
}

// Indentation-based folding: a line opens a region when following lines are
// indented deeper, and the region runs until the indent returns to the header's
// level or less. Language-agnostic — the universal fallback, and the only
// provider for indentation-significant languages (Python, YAML, …).
export function indentationFoldRanges(code: string): FoldRange[] {
  const lines = code.split("\n");
  const ranges: FoldRange[] = [];
  // Open headers, increasing indent up the stack. 0-based line numbers.
  const stack: { indent: number; line: number }[] = [];
  let lastNonBlank = 0;

  const close = (header: { indent: number; line: number }) => {
    // Only a real region if it hides at least one line.
    if (lastNonBlank > header.line) {
      ranges.push({ startLine: header.line + 1, endLine: lastNonBlank + 1 });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const indent = indentOf(lines[i]);
    if (indent === null) continue; // blank — absorbed, doesn't move lastNonBlank
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      close(stack.pop()!);
    }
    stack.push({ indent, line: i });
    lastNonBlank = i;
  }
  while (stack.length) close(stack.pop()!);

  return ranges;
}

// Bracket/syntax folding from the symbol-token index — match {} [] () pairs but
// ONLY where the token index classifies the position as "code", so brackets
// inside strings/comments are ignored. This is the whole reason it depends on
// the token model. TODO: implement once the token index is shared into CodeBlock
// (see notes in the symbol-click-gate memory). Returns [] for now so the
// orchestrator's merge degrades to pure indentation.
export function bracketFoldRanges(
  code: string,
  tokenIndex: unknown
): FoldRange[] {
  // TODO: stack-match {} [] () pairs, counting only positions the token index
  // marks as "code" (skip brackets in strings/comments). See the symbol-click
  // -gate memory for the planned token-index-into-CodeBlock wiring.
  //
  // END SEMANTICS — MUST match indentationFoldRanges: endLine is the LAST HIDDEN
  // line, i.e. the line *before* the closer, so the closing `}`/`]`/`)` stays
  // visible (`foo() {` collapses to `foo() {…}`). Diverging here would make the
  // same block emit two ranges differing by one line, which mergeFoldRanges
  // would treat as a same-start conflict instead of deduping it away. Match the
  // convention and identical blocks collapse to one range for free.
  void code;
  void tokenIndex;
  return [];
}

// Merge fold ranges from multiple providers into a single valid fold tree.
// Earlier lists win on conflicts (pass higher-precedence providers first, e.g.
// bracket before indentation). Two invariants the fold UI relies on:
//   1. At most one range per start line — the apply step keys a Map by startLine
//      and the gutter stamps one chevron per line.
//   2. Properly nested (no partial overlaps) — so collapsing regions composes
//      instead of hiding unrelated lines.
export function mergeFoldRanges(...lists: FoldRange[][]): FoldRange[] {
  const byStart = new Map<number, FoldRange>();
  for (const range of lists.flat()) {
    if (range.endLine <= range.startLine) continue; // degenerate
    if (!byStart.has(range.startLine)) byStart.set(range.startLine, range);
  }
  // Outer-first ordering so the stack below represents current ancestors.
  const sorted = [...byStart.values()].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine
  );
  const out: FoldRange[] = [];
  const stack: FoldRange[] = [];
  for (const range of sorted) {
    while (stack.length && stack[stack.length - 1].endLine < range.startLine) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    // Crossing resolution is OUTER-WINS (the earlier-starting range is kept),
    // NOT precedence-aware — provider identity is already gone by here. Fine
    // because crossings only arise from a mis-segmented provider (mixed tabs,
    // odd dedent) and keeping the larger enclosing range is the safe default. If
    // bracket should beat indentation even on a crossing, accept providers in
    // priority order and reject a range that crosses any already-accepted one.
    if (parent && range.endLine > parent.endLine) continue; // crosses → drop
    out.push(range);
    stack.push(range);
  }
  return out;
}

export interface ComputeFoldOptions {
  language?: string;
  // The symbol-token index for `code`, enabling bracket folding. Untyped here to
  // avoid a hard dep cycle with symbol-tokens; the bracket provider narrows it.
  tokenIndex?: unknown;
}

// Orchestrator: run the providers and merge them into one valid fold tree.
// Bracket goes first so it wins per-line conflicts; it's a no-op until a token
// index is wired through, so today the result is pure indentation. When bracket
// returns ranges, indentation will fill the gaps it misses (JSX, comment blocks).
export function computeFoldRanges(
  code: string,
  opts: ComputeFoldOptions = {}
): FoldRange[] {
  return mergeFoldRanges(
    bracketFoldRanges(code, opts.tokenIndex),
    indentationFoldRanges(code)
  );
}
