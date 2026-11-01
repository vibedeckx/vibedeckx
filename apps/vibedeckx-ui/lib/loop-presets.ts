/**
 * New loop presets (docs/superpowers/specs/2026-10-31-loop-presets-design.md §2).
 *
 * A preset is a fixed instruction skeleton plus a few project-specific fields.
 * The dialog offers presets as where a loop's items come from ("Items from"):
 * a plan file, or the instruction itself (`custom`). A new item source — e.g.
 * the project's tasks — is a new kind here, not a second axis.
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
  /** Without it the preset generates no instruction. */
  required?: boolean;
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

const READ_DOCS_FIELD: LoopPresetField = {
  key: "readDocs", label: "Docs to read every session", multiline: true,
  placeholder: "AGENTS.md\ndocs/design.md\nOn conflicts, docs/design.md wins.",
  hint: "One per line; say which wins on a conflict.",
};

export const PLAN_PRESET: LoopPreset = {
  kind: "plan",
  label: "Plan file",
  description: "Work through a step-by-step plan in the repo, one step per session: implement, verify, commit. The loop keeps track of which steps are done.",
  fields: [
    {
      key: "planFile", label: "Plan file", placeholder: "docs/implementation-plan.md",
      hint: "Any numbered list of steps works; nothing in the file has to be ticked.",
    },
    READ_DOCS_FIELD,
  ],
  defaults: {
    planFile: "docs/implementation-plan.md",
    readDocs: "",
  },
  handoffByDefault: true,
};

export const CUSTOM_PRESET: LoopPreset = {
  kind: "custom",
  label: "Write my own",
  description: "Say in your own words where the items come from; the rest of the instruction — one item per session, verify, commit, report — is generated as for a plan.",
  fields: [
    {
      key: "source", label: "Where items come from", required: true, multiline: true,
      placeholder: "Each error `pnpm lint` reports.\nOr: each file in todo/; move it to done/ when finished.",
      hint: "How a session finds the next item, and how a finished one drops out of the list. Sessions remember nothing of each other.",
    },
    READ_DOCS_FIELD,
  ],
  defaults: { source: "", readDocs: "" },
  // Arbitrary source: a note every turn is not obviously worth its tokens.
  handoffByDefault: false,
};

export const LOOP_PRESETS: readonly LoopPreset[] = [PLAN_PRESET, CUSTOM_PRESET];

export function presetFor(kind: LoopPresetKind): LoopPreset {
  return kind === "plan" ? PLAN_PRESET : CUSTOM_PRESET;
}

/** Non-empty trimmed lines of a multi-line field. */
function lines(raw: string | undefined): string[] {
  return (raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** A single-line field, or its default when left blank. */
function value(fields: Record<string, string>, key: string): string {
  return fields[key]?.trim() || PLAN_PRESET.defaults[key] || "";
}

const bullets = (items: string[], indent = ""): string => items.map((l) => `${indent}- ${l}`).join("\n");
/** The user's own prose, quoted under a list entry. */
const quoted = (items: string[]): string => items.map((l) => `  > ${l}`).join("\n");

// Lines both templates share, word for word.
const LEDGER_LINE = (thing: string) =>
  `- The loop records which ${thing}s earlier sessions completed and lists them at the top of this message ("已完成的项"). No list means no ${thing} has been recorded yet — this is the first session, or a restart.`;
const RETRY_LINE = "do not repeat an approach that already failed.";
const PROJECT_CHECKS_LINE = "- Also run the project's own checks every session — typecheck, tests, lint, whatever its docs or scripts define.";
const DEFAULTS_LINE = (spec: string) =>
  `- A threshold or parameter ${spec} does not specify is not a blocker: pick a defensible default, keep it in one configurable place (a constants module or config), note the value and the reason in the commit body, and carry on.`;
const BLOCKED_LINE = "- Something only a human can provide blocks the way (secrets, credentials, external accounts, a decision only a person can make): commit as usual, then end with `Status: blocked` and say exactly what is needed and where it goes (which environment variable or file). Do not work around it, do not fake secrets, and never write secrets into the repository.";

/**
 * Plan file template — a port of the Ralph `prompt.md` skeleton with four
 * differences (design §2.2, §5.3): no progress.md section, the `<promise>`
 * markers replaced by the loop's closing Status lines, the verification
 * commands written into the instruction for the agent to run, and no
 * pending/done markers — the loop records completed steps from the closing
 * `Item:` line and shows the list to every session.
 */
function planInstruction(fields: Record<string, string>): string {
  const plan = value(fields, "planFile");
  const readDocs = lines(fields.readDocs);

  const sections: string[] = [];
  sections.push(
    `You are implementing this project by following the plan in \`${plan}\`. Each session completes exactly ONE step: implement it, verify it, commit it, then stop.`,
  );

  const read = [
    `- \`${plan}\` — the plan, a sequence of numbered steps.`,
    LEDGER_LINE("step"),
  ];
  if (readDocs.length) read.push(`- Also read these every session:\n${bullets(readDocs, "  ")}`);
  sections.push(`## 1. Read first\n\n${read.join("\n")}`);

  sections.push([
    "## 2. Pick the step",
    "",
    "Go through the steps in order and pick the first one that is NOT in the completed list and whose dependencies are all done. Do only that one; do not start later steps early.",
    "Before you change anything, check whether the step is in fact already done — an earlier session may have finished it without the loop recording it (a restart, an interrupted session), or the plan file may already mark it done. If its acceptance criteria are met and its verification passes, do not redo it: report it as this session's item (section 7) and stop.",
    `If the step was attempted before and left unfinished, find out why before you start, and ${RETRY_LINE}`,
  ].join("\n"));

  const implement = [
    "- Before changing anything, read the design sections the step references and the existing code around it. Implement what is written, reuse the existing abstractions, and do not build a parallel one.",
    "- Change only what is in scope for this step; the main branch must always build and run.",
  ];
  sections.push(`## 3. Implement\n\n${implement.join("\n")}`);

  sections.push([
    "## 4. Verify",
    "",
    "Meet every acceptance criterion of the step, and actually RUN the verification — do not just claim it passes.",
    "",
    PROJECT_CHECKS_LINE,
    "- If the environment truly cannot satisfy a check, use the fallback the plan gives, and say which check, why, and when it will be made up — in your final message and in the commit message.",
    DEFAULTS_LINE("the plan"),
  ].join("\n"));

  sections.push([
    "## 5. Mark it done",
    "",
    "The loop records completion from the `Item:` line of your final message (section 7); you do not have to edit the plan for that.",
    "If the plan file itself tracks per-step status — a checkbox, a status line, a pass-condition flag — update that step's entry in the file's own convention once the criteria are really met. Otherwise leave the plan file alone.",
    "If you cannot finish the step, do not report it as done; say why in your final message.",
  ].join("\n"));

  sections.push([
    "## 6. Commit",
    "",
    "Commit everything from this session — the code, and the plan file if you updated it — in ONE git commit:",
    "- Title like `<step number>: <summary>`.",
    "- Body: what was done, the key decisions, and the verification commands actually run with their results.",
    "",
    "The session is not over until the commit is made. Do not push.",
  ].join("\n"));

  sections.push([
    "## 7. Report",
    "",
    "- Every step in the plan is done (none left outside the completed list): end with `Status: done`.",
    BLOCKED_LINE,
    "- Otherwise: end with `Status: continue`, set `Item:` to the step number, and `Remaining:` to the number of steps still not done.",
  ].join("\n"));

  return sections.join("\n\n");
}

/**
 * Write my own template — the Plan file skeleton with the plan swapped for the
 * user's own description of where items come from. How a finished item leaves
 * the source is that description's job too: the template only follows it, and
 * never invents a marking step. Nothing without it: there is no default source.
 */
function customInstruction(fields: Record<string, string>): string {
  const source = lines(fields.source);
  if (!source.length) return "";
  const readDocs = lines(fields.readDocs);

  const sections: string[] = [];
  sections.push(
    "You are working through a list of items, one per session. Each session handles exactly ONE item: handle it, verify it, commit it, then stop.",
  );

  const read = [`- Where the items come from:\n${quoted(source)}`, LEDGER_LINE("item")];
  if (readDocs.length) read.push(`- Also read these every session:\n${bullets(readDocs, "  ")}`);
  sections.push(`## 1. Read first\n\n${read.join("\n")}`);

  sections.push([
    "## 2. Pick the item",
    "",
    "Find the items as described above and pick the first one that is NOT in the completed list. Do only that one.",
    "Before you change anything, check whether it is in fact already handled — an earlier session may have finished it without the loop recording it (a restart, an interrupted session). If it is, do not redo it: report it as this session's item (section 7) and stop.",
    `If the item was attempted before and left unfinished, find out why before you start, and ${RETRY_LINE}`,
  ].join("\n"));

  sections.push([
    "## 3. Handle it",
    "",
    "- Before changing anything, read the code and docs around the item. Reuse the existing abstractions, and do not build a parallel one.",
    "- Change only what this item needs; the main branch must always build and run.",
  ].join("\n"));

  sections.push([
    "## 4. Verify",
    "",
    "Make sure the item is really handled, and actually RUN whatever shows it — do not just claim it works.",
    "",
    PROJECT_CHECKS_LINE,
    DEFAULTS_LINE("the item's description"),
  ].join("\n"));

  sections.push([
    "## 5. Mark it done",
    "",
    "The loop records completion from the `Item:` line of your final message (section 7).",
    "If the description of where the items come from says how a finished item is marked (moved, ticked, closed …), do that once the item is really handled. Otherwise leave the source alone.",
    "If you cannot finish the item, do not report it as done; say why in your final message.",
  ].join("\n"));

  sections.push([
    "## 6. Commit",
    "",
    "If this session changed files in the repository, commit them in ONE git commit:",
    "- Title like `<item>: <summary>`.",
    "- Body: what was done, the key decisions, and the verification commands actually run with their results.",
    "",
    "If nothing in the repository changed, there is nothing to commit. Do not push.",
  ].join("\n"));

  sections.push([
    "## 7. Report",
    "",
    "- No item is left to pick (every item is in the completed list or already handled): end with `Status: done`.",
    BLOCKED_LINE,
    "- Otherwise: end with `Status: continue`, set `Item:` to a short name for this item that a later session will recognize in the completed list, and `Remaining:` to the number of items still left, if you can tell.",
  ].join("\n"));

  return sections.join("\n\n");
}

/** The instruction a preset generates from its fields; empty while a required field is blank. */
export function generateInstruction(kind: LoopPresetKind, fields: Record<string, string>): string {
  return kind === "plan" ? planInstruction(fields) : customInstruction(fields);
}

/** The fields worth recording on the run: only the preset's own keys, blanks dropped. */
export function presetFieldsForMeta(kind: LoopPresetKind, fields: Record<string, string>): Record<string, string> | undefined {
  const keys = presetFor(kind).fields.map((f) => f.key);
  const out: Record<string, string> = {};
  for (const k of keys) if (fields[k]?.trim()) out[k] = fields[k];
  return Object.keys(out).length ? out : undefined;
}

/** "Own: <first line of the description>", clipped; runs from before the field existed have none. */
function ownSourceLabel(source: string | undefined): string {
  const first = lines(source)[0];
  if (!first) return "Own instruction";
  const chars = Array.from(first);
  return `Own: ${chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : first}`;
}

/** The loop card's "source" line, or null for runs started before presets existed. */
export function presetSourceLabel(preset: LoopPresetMeta | null | undefined): string | null {
  if (!preset) return null;
  const base = preset.kind === "plan"
    ? `Plan: ${preset.fields?.planFile?.trim() || PLAN_PRESET.defaults.planFile}`
    : preset.kind === "custom" ? ownSourceLabel(preset.fields?.source) : null;
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
