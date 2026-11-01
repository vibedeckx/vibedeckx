/**
 * New loop presets (docs/superpowers/specs/2026-10-31-loop-presets-design.md §2).
 *
 * A preset is a fixed instruction skeleton plus a few project-specific fields.
 * Generation is ONE-WAY: fields → instruction text. Once the user edits the
 * text by hand, the text is the only truth and the fields stop applying —
 * reading fields back out of free text is not attempted.
 *
 * Pure module (no React, no `@/` imports): unit-tested here, and the backend
 * contract test imports it to compare the protocol preview with the engine's.
 */

export type LoopPresetKind = "plan" | "custom";

/** What a started loop records about where its instruction came from (display only). */
export interface LoopPresetMeta {
  kind: LoopPresetKind;
  fields?: Record<string, string>;
  /** The instruction was edited by hand after generation. */
  edited?: boolean;
}

export interface LoopPresetField {
  key: string;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface LoopPreset {
  kind: LoopPresetKind;
  label: string;
  description: string;
  fields: readonly LoopPresetField[];
  defaults: Readonly<Record<string, string>>;
  /** Initial state of "Keep a handoff note" (design §5.1): a known source makes the note worth it. */
  handoffByDefault: boolean;
}

export const PLAN_PRESET: LoopPreset = {
  kind: "plan",
  label: "Plan file",
  description: "Work through a step-by-step plan in the repo, one step per session: implement, verify, commit.",
  fields: [
    { key: "planFile", label: "Plan file", placeholder: "docs/implementation-plan.md" },
    { key: "pendingMarker", label: "Pending marker", placeholder: "**Pass condition.** False" },
    { key: "doneMarker", label: "Done marker", placeholder: "**Pass condition.** True" },
    {
      key: "readDocs", label: "Docs to read every session", multiline: true,
      placeholder: "AGENTS.md\ndocs/design.md\nOn conflicts, docs/design.md wins.",
      hint: "One per line; say which wins on a conflict.",
    },
    {
      key: "constraints", label: "Constraints that must never be violated", multiline: true,
      placeholder: "No new runtime dependencies\nAll DB access goes through the repository layer",
    },
    {
      key: "verifyCommands", label: "Verification commands (run by the agent)", multiline: true,
      placeholder: "npm run typecheck\nnpm test",
      hint: "The agent runs these. The Check command below is a separate check the loop runs itself.",
    },
    {
      key: "readyResources", label: "Already available — not a blocker", multiline: true,
      placeholder: "gh is logged in\nThe dev database is configured",
    },
  ],
  defaults: {
    planFile: "docs/implementation-plan.md",
    pendingMarker: "**Pass condition.** False",
    doneMarker: "**Pass condition.** True",
    readDocs: "",
    constraints: "",
    verifyCommands: "",
    readyResources: "",
  },
  handoffByDefault: true,
};

export const CUSTOM_PRESET: LoopPreset = {
  kind: "custom",
  label: "Custom",
  description: "Write the whole instruction yourself.",
  fields: [],
  defaults: {},
  // Unknown source: a note every turn is not obviously worth its tokens.
  handoffByDefault: false,
};

export const LOOP_PRESETS: readonly LoopPreset[] = [PLAN_PRESET, CUSTOM_PRESET];

export function presetFor(kind: LoopPresetKind): LoopPreset {
  return kind === "plan" ? PLAN_PRESET : CUSTOM_PRESET;
}

/**
 * Verbatim copy of the engine's `TASK_STATUS_INSTRUCTIONS`
 * (packages/vibedeckx/src/utils/review-verdict.ts), shown read-only under the
 * instruction: the loop appends it and parses the reply by it. A backend test
 * fails if the two drift apart.
 */
export const TASK_STATUS_PROTOCOL_PREVIEW = [
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
 * Verbatim copy of the engine's `HANDOFF_INSTRUCTIONS` (same file), appended
 * after the status protocol when the loop keeps a handoff note. Same drift test.
 */
export const HANDOFF_PROTOCOL_PREVIEW = [
  "",
  "Then, as the very last part of your message, write a handoff note for the next session:",
  "Handoff:",
  "<rewrite the whole note each time: a short \"known lessons\" list (project quirks, dead ends,",
  "conventions) plus the last few handoffs (step, result, decisions, what to watch). Keep it",
  "under ~40 lines; drop what no longer applies. Do not start any line of it with",
  "\"Status:\", \"Item:\" or \"Remaining:\".>",
].join("\n");

/** Non-empty trimmed lines of a multi-line field. */
function lines(raw: string | undefined): string[] {
  return (raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** A single-line field, or its default when left blank. */
function value(fields: Record<string, string>, key: string): string {
  return fields[key]?.trim() || PLAN_PRESET.defaults[key] || "";
}

const bullets = (items: string[], indent = ""): string => items.map((l) => `${indent}- ${l}`).join("\n");

/**
 * Plan file template — a port of the Ralph `prompt.md` skeleton with three
 * differences (design §2.2): no progress.md section, the `<promise>` markers
 * replaced by the loop's closing Status lines, and the verification commands
 * written into the instruction for the agent to run.
 */
function planInstruction(fields: Record<string, string>): string {
  const plan = value(fields, "planFile");
  const pending = value(fields, "pendingMarker");
  const done = value(fields, "doneMarker");
  const readDocs = lines(fields.readDocs);
  const constraints = lines(fields.constraints);
  const verify = lines(fields.verifyCommands);
  const ready = lines(fields.readyResources);

  const sections: string[] = [];
  sections.push(
    `You are implementing this project by following the plan in \`${plan}\`. Each session completes exactly ONE step: implement it, verify it, commit it, then stop.`,
  );

  const read = [`- \`${plan}\` — the plan. Each step ends with a completion marker: \`${pending}\` while pending, \`${done}\` once done.`];
  if (readDocs.length) read.push(`- Also read these every session:\n${bullets(readDocs, "  ")}`);
  sections.push(`## 1. Read first\n\n${read.join("\n")}`);

  sections.push([
    "## 2. Pick the step",
    "",
    `Go through the steps in order and pick the first one that is still pending (\`${pending}\`) and whose dependencies are all done. Do only that one; do not start later steps early.`,
    "If the step was attempted before and left unfinished, find out why before you start, and do not repeat an approach that already failed.",
  ].join("\n"));

  const implement = [
    "- Before changing anything, read the design sections the step references and the existing code around it. Implement what is written, reuse the existing abstractions, and do not build a parallel one.",
    "- Change only what is in scope for this step; the main branch must always build and run.",
  ];
  if (constraints.length) {
    implement.push(`- Constraints that must never be violated — breaking any of them means the step is not done:\n${bullets(constraints, "  ")}`);
  }
  sections.push(`## 3. Implement\n\n${implement.join("\n")}`);

  const verifyLines = [
    "Meet every acceptance criterion of the step, and actually RUN the verification — do not just claim it passes.",
    "",
  ];
  if (verify.length) verifyLines.push(`- Run these every session:\n${verify.map((c) => `  - \`${c}\``).join("\n")}`);
  verifyLines.push(
    "- If the environment truly cannot satisfy a check, use the fallback the plan gives, and say which check, why, and when it will be made up — in your final message and in the commit message.",
    "- A threshold or parameter the plan does not specify is not a blocker: pick a defensible default, keep it in one configurable place (a constants module or config), note the value and the reason in the commit body, and carry on.",
  );
  sections.push(`## 4. Verify\n\n${verifyLines.join("\n")}`);

  sections.push([
    "## 5. Mark it done",
    "",
    `Only once the acceptance criteria are really met and the verification really passed, change the step's marker to \`${done}\`. If you cannot finish it, leave it pending and say why in your final message.`,
  ].join("\n"));

  sections.push([
    "## 6. Commit",
    "",
    "Commit everything from this session — the code and the plan's marker — in ONE git commit:",
    "- Title like `<step number>: <summary>`.",
    "- Body: what was done, the key decisions, and the verification commands actually run with their results.",
    "",
    "The session is not over until the commit is made. Do not push.",
  ].join("\n"));

  const report = [
    `- Every step in the plan is done (no \`${pending}\` left): end with \`Status: done\`.`,
    "- Something only a human can provide blocks the way (secrets, credentials, external accounts, a decision only a person can make): commit as usual, then end with `Status: blocked` and say exactly what is needed and where it goes (which environment variable or file). Do not work around it, do not fake secrets, and never write secrets into the repository.",
  ];
  if (ready.length) report.push(`  Already available — not a blocker:\n${bullets(ready, "  ")}`);
  report.push("- Otherwise: end with `Status: continue`, and set `Item:` to the step number.");
  sections.push(`## 7. Report\n\n${report.join("\n")}`);

  return sections.join("\n\n");
}

/** The instruction a preset generates from its fields. Custom generates nothing. */
export function generateInstruction(kind: LoopPresetKind, fields: Record<string, string>): string {
  return kind === "plan" ? planInstruction(fields) : "";
}

/** The fields worth recording on the run: only the preset's own keys, blanks dropped. */
export function presetFieldsForMeta(kind: LoopPresetKind, fields: Record<string, string>): Record<string, string> | undefined {
  const keys = presetFor(kind).fields.map((f) => f.key);
  const out: Record<string, string> = {};
  for (const k of keys) if (fields[k]?.trim()) out[k] = fields[k];
  return Object.keys(out).length ? out : undefined;
}

/** The loop card's "source" line, or null for runs started before presets existed. */
export function presetSourceLabel(preset: LoopPresetMeta | null | undefined): string | null {
  if (!preset) return null;
  const base = preset.kind === "plan"
    ? `Plan: ${preset.fields?.planFile?.trim() || PLAN_PRESET.defaults.planFile}`
    : preset.kind === "custom" ? "Custom" : null;
  if (!base) return null;
  return preset.edited ? `${base}（已手改）` : base;
}

// ---------- last-used settings (design §2.4) ----------

export interface LoopDraft {
  kind: LoopPresetKind;
  fields: Record<string, string>;
  prompt: string;
  edited: boolean;
  agentType: "claude-code" | "codex";
  iterations: string;
  minutes: string;
  checkCommand: string;
  /** Absent in drafts saved before handoff notes existed → the preset's default. */
  handoff: boolean;
}

export const loopDraftKey = (projectId: string): string => `loop-draft:${projectId}`;

export function loadLoopDraft(projectId: string): Partial<LoopDraft> | null {
  try {
    const raw = window.localStorage.getItem(loopDraftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<LoopDraft>) : null;
  } catch {
    return null;
  }
}

export function saveLoopDraft(projectId: string, draft: LoopDraft): void {
  try {
    window.localStorage.setItem(loopDraftKey(projectId), JSON.stringify(draft));
  } catch {
    // Quota / private mode: the draft is a convenience, never a failure.
  }
}
