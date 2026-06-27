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
// level or less. Language-agnostic; good enough as an MVP before bracket- or
// syntax-aware folding is layered on the same token model.
export function computeFoldRanges(code: string): FoldRange[] {
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
