export interface FileRefIndex {
  resolve(rawPath: string): string[];
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function buildFileRefIndex(files: string[]): FileRefIndex {
  const fullPaths = new Set(files);
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const base = basenameOf(f);
    const arr = byBasename.get(base);
    if (arr) arr.push(f);
    else byBasename.set(base, [f]);
  }

  return {
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
