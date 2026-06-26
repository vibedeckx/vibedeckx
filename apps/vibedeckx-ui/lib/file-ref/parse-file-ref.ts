export interface ScannedRef {
  start: number;
  end: number;
  rawPath: string;
  line: number | null;
  // For a literal `[label](path)` match, the text to display instead of the
  // matched span (so the brackets/parens collapse into one clean link).
  display?: string;
}

// A "pathish" core must contain at least one separator (`.` or `/`) so bare
// words never match. Optional suffix: `:line(:col)?` or `#Lstart(-L?end)?`.
const FILE_REF =
  /(?<![\w./-])([\w-]+(?:[./][\w-]+)+)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?/g;

// Literal markdown-link syntax `[label](href)` appearing in plain text or inline
// code (where markdown itself does NOT parse it as a link — e.g. inside
// backticks). We collapse the whole thing into one reference.
const MD_LINK = /\[([^\]\n]*)\]\(\s*([^)\s]+?)\s*\)/g;

function hasExtensionOrSlash(rawPath: string): boolean {
  return rawPath.includes("/") || /\.[A-Za-z0-9]+$/.test(rawPath);
}

export function scanFileRefs(text: string): ScannedRef[] {
  const out: ScannedRef[] = [];
  const covered: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  // 1) Markdown-link literals first, so we don't also linkify the path/label
  //    inside them as separate bare tokens.
  MD_LINK.lastIndex = 0;
  while ((m = MD_LINK.exec(text)) !== null) {
    const parsed = parseFileHref(m[2]);
    if (!parsed || !hasExtensionOrSlash(parsed.rawPath)) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    out.push({ start, end, rawPath: parsed.rawPath, line: parsed.line, display: m[1] || undefined });
    covered.push([start, end]);
  }

  // 2) Bare path tokens, skipping anything inside a link literal already matched.
  FILE_REF.lastIndex = 0;
  while ((m = FILE_REF.exec(text)) !== null) {
    const start = m.index;
    if (covered.some(([s, e]) => start >= s && start < e)) continue;
    const rawPath = m[1];
    if (!hasExtensionOrSlash(rawPath)) continue;
    const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
    out.push({ start, end: start + m[0].length, rawPath, line });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

export function parseFileHref(
  href: string,
): { rawPath: string; line: number | null } | null {
  const h = href.trim();
  if (!h) return null;
  // Strip a trailing :line(:col)? or #Lstart(-L?end)? suffix BEFORE scheme
  // detection, so a relative href like "foo.ts:9" is not misread as a
  // "foo.ts:" URI scheme (`.` is a legal scheme character).
  const m = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(h);
  if (!m || !m[1]) return null;
  const rawPath = m[1];
  // Reject real URI schemes (http:, mailto:, …), scheme-relative, and anchors.
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(rawPath) ||
    rawPath.startsWith("//") ||
    rawPath.startsWith("#")
  ) {
    return null;
  }
  const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
  return { rawPath, line };
}
