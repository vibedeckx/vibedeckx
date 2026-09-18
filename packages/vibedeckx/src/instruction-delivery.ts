/**
 * Keyed instruction delivery — the one implementation behind every sender that
 * wants "an HTTP/process-level retry of this instruction must not deliver it
 * twice": the `/message` route, project-chat's local target, and the workflow
 * engine's dispatches.
 *
 * Semantics are honest at-least-once. `delivered` means the *runtime accepted*
 * the instruction (user entry durable, stdin write returned or the provider
 * buffered it) — not that the CLI consumed it; no provider gives us an ACK with
 * an id. A stable key removes duplicates caused by retries above stdin, never
 * the ones below it. Ledger: `agent_instruction_deliveries`.
 *
 * The lock tables are module-level on purpose: the route and the engine must
 * contend on the SAME per-session mutex, or the engine's "is the session idle?"
 * re-check would not be atomic with respect to a user message.
 */
import { createHash, randomUUID } from "crypto";
import type { ContentPart } from "./agent-types.js";
import type { Storage } from "./storage/types.js";

/** One per process: a claim held by this token is "ours" until its lease expires. */
const instructionReceiverToken = randomUUID();
const instructionDeliveryLocks = new Map<string, Promise<void>>();
const sessionMutationLocks = new Map<string, Promise<void>>();

async function serialize<T>(table: Map<string, Promise<void>>, key: string, effect: () => Promise<T>): Promise<T> {
  const previous = table.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  table.set(key, tail);
  await previous;
  try {
    return await effect();
  } finally {
    release();
    if (table.get(key) === tail) table.delete(key);
  }
}

/**
 * Per-session mutex shared by everything that mutates a session's turn state:
 * user `/message`, discard-if-empty, and engine dispatches. Not re-entrant.
 */
export function serializeSessionMutation<T>(sessionId: string, effect: () => Promise<T>): Promise<T> {
  return serialize(sessionMutationLocks, sessionId, effect);
}

export function instructionContentHash(content: string | ContentPart[]): string {
  const canonical = typeof content === "string"
    ? JSON.stringify({ type: "string", content })
    : JSON.stringify(content.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", mediaType: part.mediaType, data: part.data }));
  return createHash("sha256").update(canonical).digest("hex");
}

export type InstructionDeliveryResult =
  /** Runtime accepted the instruction and the ledger row is `sent`. */
  | "delivered"
  /** Same key + same content already `sent`: nothing was delivered again. */
  | "replayed"
  /** Same key, different content. Nothing delivered. */
  | "conflict"
  /** Another live claim holds the key. Nothing delivered by us. */
  | "busy"
  /** `deliver` returned false: the runtime refused before any side effect. Claim released. */
  | "not_running"
  /** Lease lost around the send. `before` = nothing sent; `after` = sent, but the row is no longer ours to mark. */
  | "ownership_lost_before_send"
  | "ownership_lost_after_send"
  /** Delivered, but the `sent` mark could not be written: a retry may deliver again. */
  | "unconfirmed";

export interface DeliverInstructionInput {
  storage: Pick<Storage, "agentInstructionDeliveries">;
  sessionId: string;
  idempotencyKey: string;
  /**
   * What the key is bound to — the sender's own text, not the delivered text
   * (a hub-appended grant block is regenerated per turn; hashing it would turn
   * a retry after a grant edit into a content conflict).
   */
  rawContent: string | ContentPart[];
  /** Performs the actual send. `false` = refused with no side effect. A throw releases the claim and propagates. */
  deliver: () => Promise<boolean>;
}

/**
 * Claim → heartbeat → deliver → markSent. Does NOT take the session mutex:
 * callers own that scope (the route also re-checks session existence under it;
 * the engine re-checks idleness).
 */
export async function deliverInstruction(input: DeliverInstructionInput): Promise<InstructionDeliveryResult> {
  const { storage, sessionId, idempotencyKey } = input;
  const ledger = storage.agentInstructionDeliveries;
  const ref = { sessionId, idempotencyKey, claimToken: instructionReceiverToken };
  return serialize(instructionDeliveryLocks, `${sessionId}\0${idempotencyKey}`, async () => {
    const claim = await ledger.claim({ ...ref, contentHash: instructionContentHash(input.rawContent) });
    if (claim === "conflict") return "conflict";
    if (claim === "sent") return "replayed";
    if (claim === "busy") return "busy";

    let ownershipLost = false;
    const renew = async () => {
      try {
        if (!(await ledger.renewClaim(ref))) ownershipLost = true;
      } catch { ownershipLost = true; }
    };
    await renew();
    const heartbeat = setInterval(() => { void renew(); }, 10_000);
    heartbeat.unref();
    try {
      if (ownershipLost) return "ownership_lost_before_send";
      if (!(await input.deliver())) {
        await ledger.release(ref);
        return "not_running";
      }
      await renew();
      if (ownershipLost) return "ownership_lost_after_send";
      return (await ledger.markSent(ref)) ? "delivered" : "unconfirmed";
    } catch (error) {
      await ledger.release(ref);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  });
}
