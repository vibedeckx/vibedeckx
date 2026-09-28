/**
 * Split speakable text into synthesize-sized chunks. Chunks end on sentence
 * boundaries where possible; the first one is kept short so the first audio
 * arrives fast, the rest are packed up to `maxChars`.
 */

export const FIRST_CHUNK_MAX = 200;

const HARD_END = new Set(["。", "！", "？", "!", "?", "…", "\n"]);
const SOFT_BREAK_RE = /(?<=[，,；;、：:])/;

/** Sentence-ish segments, delimiters kept. "." only ends a sentence before whitespace/end (not "a.ts", "3.14"). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEnd = HARD_END.has(ch) || (ch === "." && (i + 1 === text.length || /\s/.test(text[i + 1])));
    if (!isEnd) continue;
    // Swallow runs like "?!" or "。」".
    while (i + 1 < text.length && (HARD_END.has(text[i + 1]) || /[”"'」』)）]/.test(text[i + 1]))) i++;
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Break one over-long segment at commas, then hard-cut what is still too long. */
function splitLong(segment: string, limit: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const piece of segment.split(SOFT_BREAK_RE)) {
    if ((current + piece).length <= limit) {
      current += piece;
      continue;
    }
    if (current) parts.push(current);
    current = piece;
    while (current.length > limit) {
      parts.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function chunkForSpeech(text: string, maxChars: number, firstMax = FIRST_CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let current = "";
  const limit = () => (chunks.length === 0 ? Math.min(firstMax, maxChars) : maxChars);
  const joiner = (a: string, b: string) => (!a ? "" : /[㐀-鿿。！？，]$/.test(a) || /^[㐀-鿿]/.test(b) ? "" : " ");

  const pushSegment = (segment: string) => {
    const candidate = current + joiner(current, segment) + segment;
    if (candidate.length <= limit()) {
      current = candidate;
      return;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (segment.length <= limit()) {
      current = segment;
      return;
    }
    const pieces = splitLong(segment, limit());
    // All but the last are full; the last may still take more sentences.
    for (const piece of pieces.slice(0, -1)) chunks.push(piece);
    current = pieces[pieces.length - 1] ?? "";
    // The first chunk's limit is tighter; re-split the tail under the new one if needed.
    if (current.length > limit()) {
      chunks.push(current);
      current = "";
    }
  };

  for (const segment of splitSentences(text)) pushSegment(segment);
  if (current) chunks.push(current);
  return chunks;
}
