import type { WorkflowVerdict } from "../storage/types.js";

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
