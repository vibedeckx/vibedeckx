/**
 * Behavioural eval for the intent-brief distillation prompts, run against a
 * real model. String assertions on SYSTEM_PROMPT verify the instructions
 * exist; these verify a real model actually follows them — which is a
 * hypothesis, not a given, for judgment-heavy tasks like settled/tentative
 * classification and dominant-question extraction.
 *
 * Opt-in and CI-invisible, like the protocol live probes. Full runbook:
 * docs/review-brief-eval.md. NOTE: pass the file as a plain argument — an
 * extra `-- --run` breaks vitest's file filter and runs the whole suite:
 *
 *   REVIEW_BRIEF_EVAL=1 DEEPSEEK_API_KEY=sk-… \
 *     pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts
 *
 * (OPENROUTER_API_KEY works too; DeepSeek wins when both are set, matching the
 * default fast-model provider.)
 *
 * ## Scoring and model comparison
 *
 * Every scenario is a rubric of named checks; a score table prints at the end
 * of the run whether or not the tests pass. Because LLM output is
 * nondeterministic, single runs are noisy — set REVIEW_BRIEF_EVAL_REPS to
 * repeat each scenario and score pass-rates instead of one-shot pass/fail:
 *
 *   # fast lane, 3 repetitions
 *   REVIEW_BRIEF_EVAL=1 REVIEW_BRIEF_EVAL_REPS=3 DEEPSEEK_API_KEY=… pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts
 *   # main lane, same reps — then compare the two printed tables
 *   REVIEW_BRIEF_EVAL=1 REVIEW_BRIEF_EVAL_REPS=3 REVIEW_BRIEF_EVAL_MODEL=deepseek-v4-pro DEEPSEEK_API_KEY=… pnpm --filter vibedeckx test src/utils/review-brief.eval.test.ts
 *
 * Read the comparison on two axes: the TOTAL pass-rate (quality) and how many
 * checks sit strictly between 0 and full marks (stability — a check a model
 * passes only sometimes is worse than the rate suggests, because production
 * gets one shot per review).
 *
 * Checks target distinctive fixture vocabulary rather than exact phrasing,
 * but a live LLM eval is still inherently flaky — treat a failure as a signal
 * to read the printed output, not as a red build.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { AgentMessage } from "../agent-types.js";
import { PROVIDERS } from "./chat-model.js";
import {
  serializeConversationForBrief,
  extractReversalsWithModel,
  generateIntentBriefWithModel,
  compactConversation,
} from "./review-brief.js";

const enabled = Boolean(process.env.REVIEW_BRIEF_EVAL);
const providerId = process.env.DEEPSEEK_API_KEY ? "deepseek" : process.env.OPENROUTER_API_KEY ? "openrouter" : null;
const REPS = Math.max(1, Number(process.env.REVIEW_BRIEF_EVAL_REPS ?? "1") || 1);

/**
 * Mirrors the production lane split in generateIntentBrief: judgment calls
 * (reversal + brief) run on the main-lane model, mechanical slice compression
 * on the fast lane. REVIEW_BRIEF_EVAL_MODEL therefore overrides ONLY the
 * judgment model; compaction stays pinned to the provider default (= the fast
 * lane's default) so a flash-vs-pro comparison varies one lane at a time —
 * and so scenario 3 exercises the exact model pairing production uses.
 */
function judgmentModelName(): string {
  if (!providerId) return "unconfigured";
  return process.env.REVIEW_BRIEF_EVAL_MODEL || PROVIDERS[providerId].defaultModel;
}

function compactModelName(): string {
  return providerId ? PROVIDERS[providerId].defaultModel : "unconfigured";
}

function makeModel(model: string) {
  if (!providerId) throw new Error("REVIEW_BRIEF_EVAL is set but no DEEPSEEK_API_KEY/OPENROUTER_API_KEY found");
  const def = PROVIDERS[providerId];
  return def.create(process.env[def.envKey]!, model);
}

const user = (text: string): AgentMessage => ({ type: "user", content: text, timestamp: 0 });
const agent = (text: string): AgentMessage => ({ type: "assistant", content: text, timestamp: 0 });

/**
 * Normalize model output before matching: strip markdown emphasis and fold
 * Unicode hyphens/dashes to ASCII. First live run failed on "**never** delete"
 * and a U+2011 in "read‑only" — formatting freedom, not wrong content, and the
 * eval must not punish it.
 */
function normalize(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-") // hyphen/dash variants incl. U+2011 non-breaking hyphen
    .replace(/\u00a0/g, " ");
}

/** True when `tag` ([settled]/[tentative]) and `subject` share a line. */
function taggedOnSameLine(b: string, tag: string, subject: RegExp): boolean {
  return b.split("\n").some((line) => line.toLowerCase().includes(`[${tag}`) && subject.test(line));
}

const wordCount = (b: string): number => b.split(/\s+/).filter(Boolean).length;

/**
 * One conversation hosting four evidence tiers at once — the realistic case
 * where the distiller must keep them apart:
 * - core goal stated exactly once (reproducible exports)
 * - a user-stated hard constraint (never delete rows)
 * - an explicitly accepted non-goal (IE11) -> [settled]
 * - an agent proposal the user never answered (Windows) -> [tentative]
 */
const MIXED_EVIDENCE: AgentMessage[] = [
  user(
    "Build a CSV export feature for the audit table. The whole point is that exports must be reproducible byte-for-byte: the same table state must always produce the identical file, or our customers' checksum pipelines break.",
  ),
  agent("Understood. I'll sort rows by primary key and pin the timestamp format so output is deterministic."),
  user("One absolute rule: the exporter must NEVER delete or modify audit rows, whatever happens. Read-only, always."),
  agent(
    "Noted, read-only access only. Also, I propose we skip Windows path handling for now and only support POSIX paths in the output directory option.",
  ),
  user("What does the sort do with duplicate primary keys?"),
  agent("Duplicates can't occur — the primary key is unique by definition. Should we support IE11 in the download UI?"),
  user("No, skipping IE11 is fine — don't support it, nobody here uses it."),
  agent("Done. I implemented the exporter with deterministic ordering and a POSIX-only output path."),
];

/** A long early design that one late sentence kills. */
const REVERSAL_CONVO: AgentMessage[] = [
  user("We need offline support for the dashboard."),
  agent(
    "Plan: an IndexedDB caching layer. " +
      "We store every API response keyed by URL, add cache invalidation on mutation, a background sync queue, and a schema-versioned migration story for the cache itself. " +
      // Long enough (with the rest of the conversation) to clear the 6k-char
      // floor below which the reversal pre-pass is skipped entirely.
      "Details: ".concat("the IndexedDB layer will need an eviction policy, quota handling, and a serializer for Date fields. ".repeat(70)),
  ),
  user("How big does the cache get?"),
  agent("Roughly 50MB for a heavy user, within quota. I'll start with the IndexedDB schema."),
  user("Actually, drop the IndexedDB idea entirely — no caching at all. Just always-fetch from the API and show a plain offline banner when it fails."),
  agent("Dropped. The dashboard now always-fetches and renders an offline banner on network failure."),
];

interface Check {
  name: string;
  pass: boolean;
}
interface RepResult {
  checks: Check[];
  /** Full model output (brief, reversal list, warnings) for failure messages. */
  detail: string;
}

const scoreboard = new Map<string, RepResult[]>();

/** Checks shared by every scenario that produces a brief. */
function briefBaseChecks(brief: string | null, b: string): Check[] {
  return [
    { name: "brief generated (non-null)", pass: brief !== null },
    { name: "not cut by token/char cap", pass: b !== "" && !b.includes("brief truncated at the length limit") },
    { name: "under length budget (<=600 words)", pass: b !== "" && wordCount(b) <= 600 },
  ];
}

describe.skipIf(!enabled)("review-brief live eval", () => {
  // The distill module deliberately swallows failures into null (production
  // degrades to tier 2 silently). For an eval that is anti-diagnostic, so
  // capture the module's console.warn lines and surface them in rep details.
  let warnings: string[] = [];
  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run one scenario REPS times, record scores, assert every check passed. */
  async function runReps(scenario: string, run: () => Promise<RepResult>): Promise<void> {
    const reps: RepResult[] = [];
    for (let i = 0; i < REPS; i++) {
      const before = warnings.length;
      let rep: RepResult;
      try {
        rep = await run();
      } catch (error) {
        // A thrown error (timeout, context overflow) must not vaporize the
        // scenario from the score table or kill the remaining reps.
        rep = { checks: [{ name: "completed without thrown error", pass: false }], detail: String(error) };
      }
      const repWarnings = warnings.slice(before);
      if (repWarnings.length > 0) rep.detail += `\nmodule warnings:\n${repWarnings.join("\n")}`;
      reps.push(rep);
    }
    scoreboard.set(scenario, reps);

    const failures = reps.flatMap((r, i) => r.checks.filter((c) => !c.pass).map((c) => `rep ${i + 1}: ${c.name}`));
    const failingDetails = reps
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.checks.some((c) => !c.pass))
      .map(({ r, i }) => `--- rep ${i + 1} output ---\n${r.detail}`)
      .join("\n\n");
    expect(failures, failingDetails).toEqual([]);
  }

  // Print the score table even when tests fail — that IS the eval's output.
  afterAll(() => {
    if (scoreboard.size === 0) return;
    const lines = [`\n=== review-brief eval — judgment: ${judgmentModelName()}, compaction: ${compactModelName()}, reps: ${REPS} ===`];
    let total = 0;
    let passed = 0;
    for (const [scenario, reps] of scoreboard) {
      lines.push(scenario);
      // Union of check names across reps: an errored rep carries only the
      // "completed without thrown error" check, so no single rep is canonical.
      const names: string[] = [];
      for (const rep of reps) for (const { name } of rep.checks) if (!names.includes(name)) names.push(name);
      for (const name of names) {
        const p = reps.filter((r) => r.checks.find((c) => c.name === name)?.pass).length;
        total += reps.length;
        passed += p;
        lines.push(`  ${name.padEnd(44)} ${p}/${reps.length}`);
      }
    }
    lines.push(`TOTAL ${passed}/${total} (${Math.round((100 * passed) / total)}%)`);
    // On a fully green run the briefs are otherwise invisible (details only
    // surface in failure messages) — REVIEW_BRIEF_EVAL_VERBOSE prints every
    // rep's model output for human quality inspection.
    if (process.env.REVIEW_BRIEF_EVAL_VERBOSE) {
      for (const [scenario, reps] of scoreboard) {
        reps.forEach((r, i) => lines.push(`\n### ${scenario} — rep ${i + 1}\n${r.detail}`));
      }
    }
    console.log(lines.join("\n"));
  });

  it("keeps evidence tiers apart: dominant question, hard constraint, settled vs tentative", async () => {
    const model = makeModel(judgmentModelName());
    const conversation = serializeConversationForBrief(MIXED_EVIDENCE);
    await runReps("mixed-evidence", async () => {
      const brief = await generateIntentBriefWithModel(model, conversation, { rethrowSizeFailures: true });
      const b = brief ? normalize(brief) : "";
      return {
        checks: [
          ...briefBaseChecks(brief, b),
          { name: "has a dominant-question section", pass: /(^|\n)\s*0\.|dominant question/i.test(b) },
          // Core goal stated once still anchors the brief.
          { name: "core goal captured (reproducibility)", pass: /reproducib|byte-for-byte|deterministic/i.test(b) },
          // The user's absolute rule lands as a constraint, not a preference.
          { name: "hard constraint captured (read-only)", pass: /never delete|read-only/i.test(b) },
          // Explicit user acceptance -> settled; proposal + silence -> tentative.
          { name: "IE11 tagged [settled]", pass: taggedOnSameLine(b, "settled", /IE11/i) },
          { name: "Windows/POSIX tagged [tentative]", pass: taggedOnSameLine(b, "tentative", /Windows|POSIX/i) },
        ],
        detail: `brief (${b.length} chars):\n${b}`,
      };
    });
  }, 120_000 * REPS);

  it("weighs finality over volume: a one-line kill beats a long early design", async () => {
    const model = makeModel(judgmentModelName());
    const conversation = serializeConversationForBrief(REVERSAL_CONVO);
    await runReps("reversal", async () => {
      const reversals = await extractReversalsWithModel(model, conversation);
      const brief = reversals
        ? await generateIntentBriefWithModel(model, conversation, { reversals, rethrowSizeFailures: true })
        : null;
      const b = brief ? normalize(brief) : "";
      // IndexedDB may appear only as a rejected approach — never unqualified
      // on a line that lacks rejection language. (\bdrop\w*: live run 1
      // reported the kill as the user's verbatim "drop the IndexedDB idea".)
      const unqualified = b
        .split("\n")
        .filter((l) => /IndexedDB/i.test(l))
        .filter((l) => !/reject|\bdrop\w*|superseded|abandon|instead|\bnot\b|\bno\b|rather than/i.test(l));
      return {
        checks: [
          { name: "reversal list generated", pass: reversals !== null },
          { name: "reversal names IndexedDB", pass: reversals !== null && /IndexedDB/i.test(reversals) },
          ...briefBaseChecks(brief, b),
          { name: "final approach reported (always-fetch)", pass: /always-fetch|no caching|offline banner/i.test(b) },
          { name: "IndexedDB only as rejected", pass: b !== "" && unqualified.length === 0 },
        ],
        detail: `reversals:\n${reversals ?? "(null)"}\n\nbrief (${b.length} chars):\n${b}`,
      };
    });
  }, 180_000 * REPS);

  it("settled/tentative attribution survives compaction", async () => {
    const judgmentModel = makeModel(judgmentModelName());
    const compactModel = makeModel(compactModelName());
    // Pad the mixed-evidence conversation so the older turns must go through
    // the compactor while the padding (not the evidence) fills the slices.
    const padded: AgentMessage[] = [
      ...MIXED_EVIDENCE.slice(0, -1),
      agent("Progress note: " + "refactoring internal helpers, nothing decided here. ".repeat(60)),
      ...MIXED_EVIDENCE.slice(-1),
    ];
    await runReps("compaction-survival", async () => {
      const compacted = await compactConversation(compactModel, padded, { sliceChars: 3_000 });
      // rethrowSizeFailures: a timeout/context overflow must surface as the
      // thrown error naming the cause, not collapse into an opaque null.
      const brief = compacted
        ? await generateIntentBriefWithModel(judgmentModel, compacted, { rethrowSizeFailures: true })
        : null;
      const b = brief ? normalize(brief) : "";
      return {
        checks: [
          { name: "compaction produced", pass: compacted !== null },
          ...briefBaseChecks(brief, b),
          // The who-decided distinction must survive the compression hop.
          { name: "IE11 [settled] survives compaction", pass: taggedOnSameLine(b, "settled", /IE11/i) },
          { name: "Windows/POSIX [tentative] survives", pass: taggedOnSameLine(b, "tentative", /Windows|POSIX/i) },
        ],
        detail: `compacted input:\n${compacted ?? "(null)"}\n\nbrief (${b.length} chars):\n${b}`,
      };
    });
  }, 240_000 * REPS);
});
