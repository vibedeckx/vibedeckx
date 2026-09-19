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
    const headerMatch = lines[0].match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

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
