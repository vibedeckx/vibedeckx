import type { AgentMessage } from "@/hooks/use-agent-session";

/**
 * The turn's answer = the LAST assistant text before a turn_end divider.
 * Walking backwards, the first assistant hit is that last one.
 *
 * Only the previous turn_end bounds the walk. User entries do NOT: a queued
 * user message can be persisted just before the divider even though the CLI
 * executes it in the next semantic turn (see session-history-window.ts), and
 * interactive tools insert mid-turn user answers — both sit between the
 * divider and the answer and must be skipped, like tool and thinking entries.
 * Hitting the previous stop point first means the turn ended without a text
 * answer (e.g. cancelled mid-tool).
 */
export function extractTurnAnswer(
  messages: Array<AgentMessage | undefined>,
  dividerIndex: number,
): string | null {
  for (let i = dividerIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === "assistant" && m.content.trim()) return m.content.trim();
    if (m.type === "turn_end") break;
  }
  return null;
}
