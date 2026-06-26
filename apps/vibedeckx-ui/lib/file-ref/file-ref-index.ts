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

export function buildFileRefIndex(files: string[]): FileRefIndex {
  const version = `idx-${++nextIndexVersion}`;
  const fullPaths = new Set(files);
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
