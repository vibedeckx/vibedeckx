/** Word boundaries in project names: "orchestrator-core", "web_ui", "api/gateway". */
const WORD_SEPARATORS = /[\s._/\\-]+/;

/**
 * Letters standing in for a project icon, derived from the project name.
 *
 * Slicing walks code points rather than UTF-16 code units, so a name whose
 * leading characters are astral ("a🧩b", CJK extension blocks) can never be cut
 * mid surrogate pair and rendered as a replacement glyph.
 *
 * Returns "" when the name yields nothing usable — callers render a neutral
 * icon rather than a placeholder like "??", which reads as broken data.
 *
 * Note: splitting is by code point, not grapheme cluster, so a ZWJ emoji
 * sequence contributes only its first component. Acceptable for a 16px chip,
 * and it avoids depending on Intl.Segmenter.
 */
export function projectInitials(name: string, max: 1 | 2 = 2): string {
  const words = name.split(WORD_SEPARATORS).filter(Boolean);
  if (words.length === 0) return "";

  if (max === 2 && words.length >= 2) {
    const first = Array.from(words[0])[0] ?? "";
    const second = Array.from(words[1])[0] ?? "";
    if (first && second) return (first + second).toLowerCase();
  }

  return Array.from(words[0]).slice(0, max).join("").toLowerCase();
}
