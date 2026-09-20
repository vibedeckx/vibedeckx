import type { WorkflowTaskStatus, WorkflowVerdict } from "../storage/types.js";

const VERDICTS: readonly WorkflowVerdict[] = ["ship", "needs-changes", "cannot-verify"];

/**
 * Reduce one line to the bare verdict value: drop list numbering / heading marks, markdown
 * emphasis / code ticks and the `verdict` label, then trim separators from the
 * ENDS only — the hyphen inside `needs-changes` must survive.
 */
function bareValue(line: string): string {
  return line
    .replace(/^\s*(?:#+|>|[-*+]|\d+[.)、])\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/verdict/gi, "")
    .replace(/^[\s:：—–\-.。]+|[\s:：—–\-.。]+$/g, "")
    .toLowerCase();
}

/**
 * Parse the reviewer's closing verdict (VERDICT_INSTRUCTIONS: "Verdict —
 * exactly one of: ship / needs-changes / cannot-verify").
 *
 * EXACT match, not "contains the word": `Verdict: do not ship` contains `ship`
 * and nothing else, and reading it as a pass would flip the gate's primary
 * action to "accept" and cancel the next review round. No natural-language
 * judgement is attempted — anything that is not precisely one of the three
 * values is `null`, which the workflow treats like `cannot-verify`: the human
 * decides. The cost of a false `null` is one click; a false `ship` ends a loop.
 *
 * The LAST line mentioning "verdict" wins (a review may discuss verdicts
 * before giving one). If that line carries only the label, the value is taken
 * from the next non-empty line, under the same exact-match rule.
 */
export function parseVerdict(text: string | null | undefined): WorkflowVerdict | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let labelLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/verdict/i.test(lines[i])) { labelLine = i; break; }
  }
  if (labelLine < 0) return null;

  let value = bareValue(lines[labelLine]);
  if (value === "") {
    const next = lines.slice(labelLine + 1).find((l) => l.trim() !== "");
    if (next === undefined) return null;
    value = bareValue(next);
  }
  return (VERDICTS as readonly string[]).includes(value) ? (value as WorkflowVerdict) : null;
}

// ---------- repeat-loop closing fields ----------


const TASK_STATUSES: readonly WorkflowTaskStatus[] = ["continue", "done", "blocked"];

/**
 * Appended to every repeat-loop iteration's instruction. The engine reads only
 * `Status` for control flow; `Item` feeds the no-progress brake and the panel,
 * `Remaining` the panel alone.
 */
export const TASK_STATUS_INSTRUCTIONS = [
  "",
  "This instruction runs repeatedly, each time in a fresh session with no memory of the previous ones. Process exactly ONE item, then stop — the next session picks up the next item.",
  "End your final message with these lines:",
  "Status: <exactly one of: continue / done / blocked>",
  "  continue — you completed one item and more remain (or may remain)",
  "  done — you checked, and there is nothing left to process",
  "  blocked — you could not complete an item and need a human",
  "Item: <one short line identifying the item you processed; omit when done>",
  "Remaining: <how many items are left, if you know; otherwise omit>",
].join("\n");

/**
 * Value of the LAST line that starts with `<label>:` (list / heading /
 * emphasis marks allowed before it), or null. Unlike a verdict, these labels
 * are everyday words ("HTTP status 200", "the item"), so the label must open
 * the line and be followed by a separator — a mention in prose never counts.
 */
export function parseClosingLine(text: string | null | undefined, label: string): string | null {
  if (!text) return null;
  const opener = new RegExp(`^\\s*(?:#+|>|[-*+]|\\d+[.)、])?\\s*[*_\`]*${label}[*_\`]*\\s*[:：]\\s*(.*)$`, "i");
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = opener.exec(lines[i]);
    if (match) return match[1].replace(/[*_`]/g, "").trim();
  }
  return null;
}

/**
 * Closing status of a repeat-loop iteration. Same discipline as parseVerdict:
 * EXACT match or null, and null is handled like `blocked` (stop, ask the
 * human). The asymmetry that matters here: a false `continue` costs one idle
 * session that finds nothing and reports `done`; a false `done` ends the loop
 * early with items unprocessed — and looks like success. So `not done yet`,
 * `done (mostly)` and `done?` must all read as null.
 */
export function parseTaskStatus(text: string | null | undefined): WorkflowTaskStatus | null {
  const raw = parseClosingLine(text, "Status");
  if (raw === null) return null;
  const value = raw.replace(/^[\s<\-—–.。]+|[\s>\-—–.。]+$/g, "").toLowerCase();
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as WorkflowTaskStatus) : null;
}
