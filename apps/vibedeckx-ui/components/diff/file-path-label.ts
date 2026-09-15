// Splitting a diff header path into "the part that may be dropped" and "the
// part worth keeping". End-ellipsis on a whole path eats the filename, which
// is the only bit that identifies the file — so the directory prefix is what
// truncates, and renames are folded git-style (`dir/{old → new}`) to keep both
// names inside the row.

export interface PathLabelParts {
  /** Shared leading directories, without the trailing slash. Truncatable. */
  dir: string;
  /** Renamed-away segments, relative to `dir`. Null when not a rename. */
  from: string | null;
  /** Current segments relative to `dir`, up to the shared trailing part. */
  to: string;
  /** Shared trailing segments, without the leading slash. */
  suffix: string;
}

function splitLast(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', base: path }
    : { dir: path.slice(0, slash), base: path.slice(slash + 1) };
}

export function pathLabelParts(path: string, oldPath?: string): PathLabelParts {
  if (!oldPath || oldPath === path) {
    const { dir, base } = splitLast(path);
    return { dir, from: null, to: base, suffix: '' };
  }

  const a = oldPath.split('/');
  const b = path.split('/');

  // Both sides keep at least one differing segment, so `head`/`tail` never
  // meet in the middle and consume the changed name itself.
  let head = 0;
  while (head < a.length - 1 && head < b.length - 1 && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head - 1 &&
    tail < b.length - head - 1 &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  return {
    dir: a.slice(0, head).join('/'),
    from: a.slice(head, a.length - tail).join('/'),
    to: b.slice(head, b.length - tail).join('/'),
    suffix: tail === 0 ? '' : a.slice(a.length - tail).join('/'),
  };
}
