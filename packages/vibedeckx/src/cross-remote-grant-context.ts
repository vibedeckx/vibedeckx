/**
 * The `<vremotes>` block the hub appends to every user message of a session
 * that has cross-remote grants (docs/cross-remote-session-grants-design.md §6).
 *
 * Why on every message rather than once: an MCP server's tool list and
 * instructions are read once at process start, so a grant made mid-session is
 * invisible to the model; and a single note at grant time is the first thing
 * compaction drops. The block is guidance only — the gateway's own check
 * against the grant table is what actually authorizes anything.
 */
import type { ContentPart } from "./agent-types.js";
import type { RemoteServer, Storage } from "./storage/types.js";

/** Strip the hub-injected block from text destined for a title prompt or a UI preview. */
export const VREMOTES_BLOCK_RE = /<vremotes(?:\s[^>]*)?>[\s\S]*?<\/vremotes>/g;

export function stripRemoteGrantContext(text: string): string {
  return text.replace(VREMOTES_BLOCK_RE, "").trimEnd();
}

type ContextStorage = Pick<Storage, "sessionRemoteGrants" | "remoteServers">;

/**
 * The machines a session has granted, as server rows, ordered by name.
 *
 * By name because a single `replace` stamps every row with one timestamp, so
 * the repository's tiebreak is the random server id — which would reorder the
 * list between turns for no reason the user could see. Rows the caller cannot
 * see (another tenant's, or deleted) drop out.
 */
export async function listGrantedServers(
  storage: ContextStorage,
  sessionId: string,
  userId: string | undefined,
): Promise<RemoteServer[]> {
  const ids = await storage.sessionRemoteGrants.list(sessionId);
  if (ids.length === 0) return [];
  const servers = await Promise.all(
    ids.map((id) => storage.remoteServers.getById(id, userId).catch(() => undefined)),
  );
  return servers
    .filter((s): s is RemoteServer => s !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The block for a session's current grants, or `null` when it has none.
 *
 * Machines whose tier has since been turned off are left out: the gateway
 * would refuse them anyway, and naming them would only invite the agent to
 * try.
 */
export async function buildRemoteGrantContext(
  storage: ContextStorage,
  sessionId: string,
  userId: string | undefined,
): Promise<string | null> {
  // Machines whose tier has since been turned off drop out: the gateway would
  // refuse them anyway, and naming them would only invite the agent to try.
  const usable = (await listGrantedServers(storage, sessionId, userId))
    .filter((s) => s.cross_remote_access !== "off");
  if (usable.length === 0) return null;

  const listed = usable
    .map((s) => `${s.name} (id: ${s.id}, ${s.cross_remote_access})`)
    .join(", ");
  // `names` is for the UI chip: the prose below is written for the agent, and
  // parsing it back out in the front end would be guesswork.
  const names = usable.map((s) => s.name.replace(/["<>]/g, "")).join(", ");
  return [
    `<vremotes names="${names}">`,
    `Cross-remote access granted for this session: ${listed}.`,
    "Use the cross-remote MCP tools when a request concerns one of these machines."
      + " Being granted does not mean every command should run there; the local workspace remains the default target.",
    // Diagnosing on a remote tends to carry over into fixing there, so the
    // default for changes is spelled out separately from "where to look".
    "Remote access is for inspection and diagnosis. Make code changes (editing files, git operations, installing dependencies)"
      + " in the local workspace, even when the problem was found on a remote; only modify a remote machine when the user explicitly asks for the change to be made there."
      + " If a fix can only be applied on the remote (for example, machine-specific config), propose it and ask before changing anything.",
    "</vremotes>",
  ].join("\n");
}

/** Append a block to already-composed message content, leaving it untouched when there are no grants. */
export function appendContextBlock(
  content: string | ContentPart[],
  block: string | null,
): string | ContentPart[] {
  if (!block) return content;
  if (typeof content === "string") return content.length > 0 ? `${content}\n\n${block}` : block;
  return [...content, { type: "text", text: block } satisfies ContentPart];
}

/** `buildRemoteGrantContext` + `appendContextBlock`, the form every delivery site uses. */
export async function appendRemoteGrantContext(
  storage: ContextStorage,
  sessionId: string,
  userId: string | undefined,
  content: string | ContentPart[],
): Promise<string | ContentPart[]> {
  return appendContextBlock(content, await buildRemoteGrantContext(storage, sessionId, userId));
}
