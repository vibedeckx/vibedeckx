export interface DiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  oldPath?: string;
  hunks: DiffHunk[];
  /** git judged the file binary (a NUL byte in its head) and printed no hunks. */
  binary?: true;
}

const C_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
  '\\': 0x5c, '"': 0x22,
};

/**
 * Undo `core.quotePath` (on by default): Git wraps a path in double quotes and
 * C-escapes every byte outside printable ASCII, so `docs/功能.md` reaches us as
 * `"docs/\345\212\237\350\203\275.md"`. Decoding has to run at the byte level —
 * one UTF-8 character is several `\nnn` escapes — so the escapes are collected
 * into a buffer and only read back as UTF-8 at the end. A token that is not
 * quoted is returned unchanged.
 */
export function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;

  const body = token.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf-8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      bytes.push(0x5c); // Trailing backslash — nothing to escape.
      continue;
    }
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const simple = C_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 1;
      continue;
    }
    // Not an escape Git produces: keep both characters as they came.
    bytes.push(0x5c, ...Buffer.from(next, 'utf-8'));
    i += 1;
  }

  return Buffer.from(bytes).toString('utf-8');
}

/**
 * The two sides of a `diff --git` header. Either side is quoted as a whole —
 * prefix included, `"a/docs/\345\212\237.md"` — whenever Git had to escape it,
 * and the quoted alternative is tried first so a name containing a space stays
 * unambiguous. The unquoted fallback keeps the original lazy split, which is
 * the best that form allows.
 */
const DIFF_HEADER = /^("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+)$/;

/** Decode one header token and drop its `a/` or `b/` prefix. */
function headerPath(token: string): string {
  return unquoteGitPath(token).slice(2);
}

export function parseDiffOutput(diffOutput: string): DiffFile[] {
  const files: DiffFile[] = [];

  if (!diffOutput.trim()) {
    return files;
  }

  // Split by "diff --git" to get each file's diff
  const fileDiffs = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');
    if (lines.length === 0) continue;

    // Parse file header: "a/path b/path"
    const headerMatch = lines[0].match(DIFF_HEADER);
    if (!headerMatch) continue;

    const oldPath = headerPath(headerMatch[1]);
    const newPath = headerPath(headerMatch[2]);

    // Determine status
    let status: DiffFile['status'] = 'modified';
    let finalPath = newPath;
    let finalOldPath: string | undefined;

    for (const line of lines.slice(1, 10)) {
      if (line.startsWith('new file mode')) {
        status = 'added';
        break;
      } else if (line.startsWith('deleted file mode')) {
        status = 'deleted';
        break;
      } else if (line.startsWith('rename from')) {
        status = 'renamed';
        finalOldPath = oldPath;
        break;
      }
    }

    // git's stand-in for the hunks of a file it treats as binary
    const binary = lines.some((line) => /^Binary files .* differ$/.test(line));

    // Parse hunks
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLineNo = 0;
    let newLineNo = 0;

    for (const line of lines) {
      // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        const hunkOldStart = parseInt(hunkMatch[1], 10);
        const hunkOldLines = parseInt(hunkMatch[2] || '1', 10);
        const hunkNewStart = parseInt(hunkMatch[3], 10);
        const hunkNewLines = parseInt(hunkMatch[4] || '1', 10);

        currentHunk = {
          oldStart: hunkOldStart,
          oldLines: hunkOldLines,
          newStart: hunkNewStart,
          newLines: hunkNewLines,
          lines: [],
        };
        oldLineNo = hunkOldStart;
        newLineNo = hunkNewStart;
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({
          type: 'add',
          content: line.slice(1),
          newLineNo: newLineNo++,
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({
          type: 'delete',
          content: line.slice(1),
          oldLineNo: oldLineNo++,
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldLineNo: oldLineNo++,
          newLineNo: newLineNo++,
        });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    files.push({
      path: finalPath,
      status,
      ...(finalOldPath && { oldPath: finalOldPath }),
      hunks,
      ...(binary && { binary: true as const }),
    });
  }

  return files;
}
