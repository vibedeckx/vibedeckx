export interface ScannedRef {
  start: number;
  end: number;
  rawPath: string;
  line: number | null;
}

// A "pathish" core must contain at least one separator (`.` or `/`) so bare
// words never match. Optional suffix: `:line(:col)?` or `#Lstart(-L?end)?`.
const FILE_REF =
  /(?<![\w./-])([\w-]+(?:[./][\w-]+)+)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?/g;

function hasExtensionOrSlash(rawPath: string): boolean {
  return rawPath.includes("/") || /\.[A-Za-z0-9]+$/.test(rawPath);
}

export function scanFileRefs(text: string): ScannedRef[] {
  const out: ScannedRef[] = [];
  FILE_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF.exec(text)) !== null) {
    const rawPath = m[1];
    if (!hasExtensionOrSlash(rawPath)) continue;
    const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
    out.push({ start: m.index, end: m.index + m[0].length, rawPath, line });
  }
  return out;
}

export function parseFileHref(
  href: string,
): { rawPath: string; line: number | null } | null {
  const h = href.trim();
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("#")) {
    return null;
  }
  const m = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(h);
  if (!m || !m[1]) return null;
  const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
  return { rawPath: m[1], line };
}
