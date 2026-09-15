export interface FileRefIndex {
  resolve(rawPath: string): string[];
  // Serializable identity for this index. Streamdown (the markdown renderer)
  // caches its unified processor in a module-level singleton keyed by
  // JSON.stringify of the rehype plugin options — for us `{ index }`. A
  // FileRefIndex's only other member is the `resolve` FUNCTION, which
  // JSON.stringify drops, so without this field every non-null index would
  // serialize to `{}` and collide on that key. The first project to render
  // would occupy the cache slot and every other project would reuse its
  // processor — bound to the wrong project's file list (project A linking to
  // B's files, B unable to resolve its own). A unique string per build keeps
  // the cache keys distinct so each project gets its own processor.
  version: string;
}

let nextIndexVersion = 0;

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// `root` is the checkout's absolute path as reported by list-files (absent
// from older workers). With it, an absolute reference is decided exactly:
// inside the root it must name a listed file, outside it is not a repo file at
// all — so `/tmp/screenshot.png` can no longer be hijacked by a repo file that
// happens to share its basename. Without it we fall back to the tail-match
// heuristic, which is all an older worker leaves us.
export function buildFileRefIndex(files: string[], root?: string | null): FileRefIndex {
  const version = `idx-${++nextIndexVersion}`;
  const fullPaths = new Set(files);
  const rootPrefix = root ? root.replace(/\/+$/, "") + "/" : null;
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const base = basenameOf(f);
    const arr = byBasename.get(base);
    if (arr) arr.push(f);
    else byBasename.set(base, [f]);
  }

  return {
    version,
    resolve(rawPath: string): string[] {
      if (!rawPath) return [];
      if (rootPrefix && (rawPath.startsWith("/") || rawPath.startsWith("~/"))) {
        // `~/` cannot be expanded here (the home dir is the agent machine's),
        // so it is never a repo path when the root is known.
        if (!rawPath.startsWith(rootPrefix)) return [];
        const rel = rawPath.slice(rootPrefix.length);
        return fullPaths.has(rel) ? [rel] : [];
      }
      // Normalize away leading slashes so absolute paths an agent emits (e.g. a
      // remote working dir like "/src/eve/packages/.../todo.ts") are treated the
      // same as repo-relative ones.
      const raw = rawPath.replace(/^\/+/, "");
      if (!raw) return [];
      if (raw.includes("/")) {
        if (fullPaths.has(raw)) return [raw];
        const base = basenameOf(raw);
        return (byBasename.get(base) ?? []).filter(
          (p) =>
            p === raw ||
            // The agent wrote a shorter tail of a known file ("execution/x.ts").
            p.endsWith("/" + raw) ||
            // The agent wrote a longer absolute/prefixed path whose tail is a
            // known file ("/src/eve/packages/.../x.ts").
            raw.endsWith("/" + p),
        );
      }
      return byBasename.get(raw) ?? [];
    },
  };
}
