import type { ContentPart } from "@/hooks/use-agent-session";

/**
 * The composer's Schedule chip. Selecting it makes the next message ask the
 * agent to turn this conversation into a `propose_schedule` call — the agent
 * already has the tool, users just don't know to ask for it. The instruction
 * travels as a `<vschedule>` block appended to the message text, so it needs
 * nothing from the hub or the worker; the transcript shows it as a header chip
 * and the hub strips it from titles (utils/conversation-title.ts).
 */
export const SCHEDULE_INTENT_BLOCK = [
  "<vschedule>",
  "The user picked the Schedule action for this message: turn the work from this conversation into a recurring"
    + " scheduled run by calling the propose_schedule tool (mcp__vibedeckx__propose_schedule).",
  "- Take what to run and how often from the user's message above. Where it is empty or leaves something open, infer"
    + " it from the conversation; if the frequency can't be inferred, pick a sensible one and say so — the user can"
    + " edit it on the confirmation card.",
  "- The scheduled run starts fresh, without this conversation. Carry the specifics over into a self-contained prompt"
    + " (or a command): paths, commands, what counts as pass or fail, what to report.",
  "- Only propose the schedule: don't do the work itself now, and don't write cron jobs or scripts for it. If you can't"
    + " tell what should be scheduled, ask instead of guessing. If the propose_schedule tool is not available, say so.",
  "</vschedule>",
].join("\n");

export const VSCHEDULE_MARKER_RE = /<vschedule>[\s\S]*?<\/vschedule>/g;

/** Append the block to composed message content, after any text and markers. */
export function appendScheduleIntent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? `${content}\n\n${SCHEDULE_INTENT_BLOCK}` : SCHEDULE_INTENT_BLOCK;
  }
  return [...content, { type: "text", text: SCHEDULE_INTENT_BLOCK }];
}

/** Pull the block out of message text; `found` says whether it was there. */
export function takeScheduleMarker(text: string): { text: string; found: boolean } {
  const stripped = text.replace(new RegExp(VSCHEDULE_MARKER_RE.source, "g"), "");
  return stripped === text ? { text, found: false } : { text: stripped.trimEnd(), found: true };
}
