// Pure logic for the executor terminal's line filter.
//
// The filter is a read-only VIEW over what xterm has already rendered — the
// screen plus scrollback — never a transform of the byte stream feeding it.
// PTY bytes are not line-aligned and carry cursor-movement/clear-line
// sequences, and `\r`-overwriting progress bars are thousands of frames on
// the wire but one settled line in the buffer. Reading rendered rows sidesteps
// all of that and leaves the live terminal (fit, resize, replay mute) untouched.

export interface TerminalFilter {
  id: string;
  /** Case-insensitive substring to look for. */
  pattern: string;
  /** true = hide lines containing the pattern instead of keeping them. */
  negate: boolean;
}

/**
 * Turn raw input-box text into a filter. A leading `-` or `!` makes it an
 * exclusion; `\-foo` / `\!foo` keep the punctuation literal. Returns null for
 * blank input or a bare prefix with nothing after it.
 */
export function parseFilterInput(raw: string): Omit<TerminalFilter, "id"> | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("\\-") || text.startsWith("\\!")) {
    return { pattern: text.slice(1), negate: false };
  }
  if (text.startsWith("-") || text.startsWith("!")) {
    const pattern = text.slice(1).trim();
    return pattern ? { pattern, negate: true } : null;
  }
  return { pattern: text, negate: false };
}

/**
 * A line passes when it contains every positive pattern and none of the
 * negated ones (logical AND). Chips are conjunctive, so "filter the remainder
 * again" is the same as matching all rules at once — order only affects how
 * the chips are displayed.
 */
export function lineMatches(line: string, filters: readonly TerminalFilter[]): boolean {
  const haystack = line.toLowerCase();
  for (const f of filters) {
    const hit = haystack.includes(f.pattern.toLowerCase());
    if (f.negate ? hit : !hit) return false;
  }
  return true;
}

export function applyFilters(lines: readonly string[], filters: readonly TerminalFilter[]): string[] {
  if (filters.length === 0) return [...lines];
  return lines.filter((line) => lineMatches(line, filters));
}

// The subset of xterm's IBuffer / IBufferLine the collector reads. Kept
// structural so tests and mocks need no xterm instance.
export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

/**
 * Read the buffer as logical lines: rows flagged `isWrapped` are soft wraps
 * of the row above (a long log line split at the column limit) and are joined
 * back so a match can't be lost across a wrap point. Trailing blank rows —
 * the unused part of the screen below the cursor — are dropped.
 */
export function collectLogicalLines(buffer: BufferLike): string[] {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const row = buffer.getLine(y);
    if (!row) continue;
    // Wrapped continuations keep their trailing padding trimmed too: xterm
    // pads every row to `cols`, and only the final segment's padding matters.
    const text = row.translateToString(true);
    if (row.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}
