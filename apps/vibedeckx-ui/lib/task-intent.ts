import type { ContentPart } from "@/hooks/use-agent-session";

/**
 * The composer's Task chip. Selecting it makes the next message ask the agent
 * to record work from this conversation as project tasks via `propose_task`.
 * Same transport as the Schedule chip (lib/schedule-intent.ts): a `<vtask>`
 * block appended to the message text, shown as a header chip in the
 * transcript and stripped from titles by the hub. The one rule that matters
 * more here than for schedules: record the work, don't do it — "add error
 * handling to X" reads like an order.
 */
export const TASK_INTENT_BLOCK = [
  "<vtask>",
  "The user picked the Task action for this message: record work from this conversation as project tasks by calling"
    + " the propose_task tool (mcp__vibedeckx__propose_task).",
  "- Take what to record from the user's message above. Where it is empty or vague, infer it from the conversation"
    + " (for example, what was skipped or left for later).",
  "- Only record the task. Do NOT do the work now — not even when the message reads like an instruction.",
  "- Each description must be self-contained: the task may be picked up later in a fresh session without this"
    + " conversation. Include the background, the relevant files, what remains, and how to tell it is done.",
  "- Propose several tasks in one call if the user asks to split the work.",
  "- If you can't tell what should be recorded, ask instead of guessing. If the propose_task tool is not available,"
    + " say so.",
  "</vtask>",
].join("\n");

export const VTASK_MARKER_RE = /<vtask>[\s\S]*?<\/vtask>/g;

/** Append the block to composed message content, after any text and markers. */
export function appendTaskIntent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? `${content}\n\n${TASK_INTENT_BLOCK}` : TASK_INTENT_BLOCK;
  }
  return [...content, { type: "text", text: TASK_INTENT_BLOCK }];
}

/** Pull the block out of message text; `found` says whether it was there. */
export function takeTaskMarker(text: string): { text: string; found: boolean } {
  const stripped = text.replace(new RegExp(VTASK_MARKER_RE.source, "g"), "");
  return stripped === text ? { text, found: false } : { text: stripped.trimEnd(), found: true };
}
