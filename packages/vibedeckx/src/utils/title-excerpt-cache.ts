/**
 * Excerpts of long pastes and text attachments, for conversation titles.
 *
 * Both land in a temp file on the agent's machine and the message carries
 * only a `<vpaste/>` / `<vfile/>` marker, so the title generator — which runs
 * on the hub, also for remote sessions — would otherwise see a path and a
 * size. The upload routes pass through the hub either way (written locally or
 * forwarded to the worker), so they record the head of the content here,
 * keyed by the returned temp-file path, and the first message's title is
 * built from it moments later.
 *
 * Callers record only for sessions still waiting on their title: later
 * uploads can never reach one.
 *
 * In-memory and bounded: a miss (hub restart between upload and send, eviction)
 * only degrades the title to the marker's label. Each owner gets its own quota,
 * so one user's flood of uploads evicts only their own entries; the global cap
 * bounds the whole map. Looked up by path alone — the paths carry a random
 * UUID and are only ever returned to the uploader.
 */

export const TITLE_EXCERPT_MAX_CHARS = 800;
const MAX_ENTRIES = 500;
const MAX_ENTRIES_PER_OWNER = 20;
const TTL_MS = 60 * 60 * 1000;
/** Bytes decoded when sniffing an attachment — enough for the excerpt in any script. */
const SNIFF_BYTES = 8 * 1024;

/** Insertion-ordered, oldest first — eviction walks from the front. */
const cache = new Map<string, { owner: string; excerpt: string; at: number }>();

function normalize(text: string): string {
  // Cut before collapsing: a paste can be megabytes and only its head is kept.
  // The slack absorbs whitespace runs the collapse removes.
  return text.slice(0, TITLE_EXCERPT_MAX_CHARS * 4).replace(/\s+/g, " ").trim().slice(0, TITLE_EXCERPT_MAX_CHARS);
}

export function rememberTitleExcerpt(owner: string, path: string, text: string): void {
  const excerpt = normalize(text);
  if (!path || !excerpt) return;
  cache.delete(path);
  const owned = [...cache].filter(([, entry]) => entry.owner === owner);
  for (const [key] of owned.slice(0, Math.max(0, owned.length - MAX_ENTRIES_PER_OWNER + 1))) {
    cache.delete(key);
  }
  cache.set(path, { owner, excerpt, at: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

export function getTitleExcerpt(path: string): string | null {
  const hit = cache.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(path);
    return null;
  }
  return hit.excerpt;
}

/**
 * The head of an attachment as text, or null when it isn't text (PDF, Office
 * documents, archives…): a NUL byte or more than a sprinkle of invalid UTF-8.
 */
export function textExcerptFromBytes(data: Uint8Array): string | null {
  const head = data.subarray(0, SNIFF_BYTES);
  if (head.length === 0 || head.includes(0)) return null;
  // A cut at SNIFF_BYTES can split one trailing character; drop it rather
  // than count it as invalid.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(head, { stream: true });
  const invalid = decoded.match(/�/g)?.length ?? 0;
  if (invalid > Math.max(2, decoded.length * 0.01)) return null;
  const excerpt = normalize(decoded);
  return excerpt.length > 0 ? excerpt : null;
}

/** Test-only. */
export function clearTitleExcerptCache(): void {
  cache.clear();
}
