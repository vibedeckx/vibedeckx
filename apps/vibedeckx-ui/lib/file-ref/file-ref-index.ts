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
      if (rawPath.includes("/")) {
        if (fullPaths.has(rawPath)) return [rawPath];
        const base = basenameOf(rawPath);
        return (byBasename.get(base) ?? []).filter(
          (p) => p === rawPath || p.endsWith("/" + rawPath),
        );
      }
      return byBasename.get(rawPath) ?? [];
    },
  };
}
