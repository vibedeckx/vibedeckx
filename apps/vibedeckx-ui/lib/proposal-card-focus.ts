/**
 * One-shot "scroll to this proposal card" request, from a Tasks-page source
 * link to the card in the conversation it opens. The card may mount well after
 * the navigation (the session loads first), so the request waits here for it
 * rather than being threaded through the page → conversation props. A card
 * that never mounts — scrolled out of the loaded history window — leaves the
 * request to expire; the user still lands in the right session.
 */
const TTL_MS = 30_000;

let pending: { toolUseId: string; at: number } | null = null;

export function requestProposalCardFocus(toolUseId: string): void {
  pending = { toolUseId, at: Date.now() };
}

/** True once, for the card the request names. */
export function takeProposalCardFocus(toolUseId: string | null | undefined): boolean {
  if (!toolUseId || !pending || pending.toolUseId !== toolUseId) return false;
  const fresh = Date.now() - pending.at <= TTL_MS;
  pending = null;
  return fresh;
}
