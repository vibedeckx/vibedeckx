import { generateText } from "ai";
import type { Storage } from "../storage/types.js";
import type { AgentMessage } from "../agent-types.js";
import { extractUserText } from "./session-title.js";
import { getChatProviderConfig, isModelConfigured, resolveChatModel, resolveFastChatModel } from "./chat-model.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any;

/** Floor for every model call; short inputs get exactly this. */
const BASE_TIMEOUT_MS = 15_000;
/**
 * Flat budget for the two judgment calls (reversal + brief), replacing the
 * input-scaled timeout: they run on the configured MAIN model, where
 * reasoning time dominates and barely scales with input size. Live,
 * deepseek-v4-pro took ~30s on a 2.5k-char input and blew a 45s budget on a
 * compacted conversation. An early abort is doubly bad here: it masquerades
 * as a size failure and triggers a pointless compaction retry, so the
 * ceiling must comfortably clear a normal slow completion (~2x observed).
 */
const JUDGMENT_TIMEOUT_MS = 90_000;
/** Added per 1k chars of input — a 120k-char prompt gets ~29s, not 15s. */
const TIMEOUT_MS_PER_1K_CHARS = 120;
const MAX_TIMEOUT_MS = 60_000;

const PER_MESSAGE_MAX_CHARS = 6_000;
/** Above this the conversation is compacted before distillation. */
const COMPACT_TRIGGER_CHARS = 120_000;
/**
 * Slice sizes tried in order. We cannot introspect the window of whatever
 * model the user configured, so the first value is a guess and the rest are
 * the retreat: when the model rejects a slice as too long we come back with a
 * smaller one. Bounded by construction — three attempts, then tier 2.
 */
const COMPACT_SLICE_BUDGETS = [96_000, 24_000, 6_000];
/** Share of the slice budget kept verbatim from the newest end. */
const RECENT_VERBATIM_RATIO = 0.3;
const MIN_RECENT_VERBATIM_CHARS = 2_000;
/** Cost ceiling: beyond this many slices we degrade to tier 2 instead. */
const MAX_FOLD_CALLS = 8;

// Token caps budget for reasoning-capable models, which spend thinking tokens
// inside maxOutputTokens before any visible text: live eval on deepseek-v4
// showed a tight cap either cutting output mid-heading or burning the whole
// budget on reasoning and returning empty text. The *_MAX_CHARS guards, not
// these, bound what we accept downstream.
const COMPACT_SUMMARY_MAX_CHARS = 6_000;
const COMPACT_SUMMARY_MAX_TOKENS = 3_000;
const REVERSALS_MAX_CHARS = 2_000;
const REVERSALS_MAX_TOKENS = 2_000;
const BRIEF_MAX_CHARS = 4_000;
const BRIEF_MAX_TOKENS = 3_000;
/**
 * Below this the whole conversation sits comfortably inside one prompt with no
 * middle to get lost in, so the reversal pre-pass buys nothing — skip the
 * round-trip.
 */
const REVERSAL_MIN_CHARS = 6_000;

const SEP = "\n\n";

/** Appended to the brief whenever the input was compacted rather than read whole. */
export const COMPACTION_NOTE =
  "_Note: the source conversation was compressed before distillation — older turns were summarized rather than read verbatim._";

/**
 * The brief is the terminal output, read by a human and a reviewer agent, so a
 * cut here is visible to them. Mid-pipeline caps do NOT truncate — see
 * withinLimit.
 */
export const BRIEF_TRUNCATION_NOTE =
  "\n\n_[brief truncated at the length limit — treat it as incomplete]_";

export const SYSTEM_PROMPT = [
  "You distill a coding-agent conversation into an intent brief for an independent code reviewer.",
  "The reviewer will NOT see the conversation — only your brief plus the actual code, so capture what the code alone cannot show:",
  "0. Dominant question — 1 or 2 sentences: the single question the reviewer must answer to judge this work (what must actually work, toward what goal). Derive it from the conversation's own emphasis — what the user repeated, finally decided, or reversed course over — never from your own engineering judgment. If the conversation does not clearly support one, write 'unclear' instead of inventing one.",
  "1. The original request and its goal.",
  "2. Hard constraints — requirements whose violation the user would treat as failure regardless of everything else (security, data loss, an explicit compatibility or behaviour promise). Only list ones the user actually stated; an empty section is fine.",
  "3. Constraints and decisions, including approaches that were rejected and why. A rejection counts whether the user made it or the agent made it under a principle the user set.",
  "4. Non-goals, trade-offs and limitations that were acknowledged and accepted.",
  "5. Behaviour established by actually running something — observed output, exit codes, error text, which stream an error arrived on. Report what was observed; that is evidence the reviewer cannot recover by reading code.",
  "Tag every item under headings 3 and 4 with exactly [settled] or [tentative] — the bare tag; keep any justification to a few words or omit it, always after the tag, never inside the brackets. Settled ONLY when the user explicitly confirmed it, instructed it, or reversed course to it; an agent proposal the user never answered is tentative — silence is never settled.",
  "Within each heading, order items by how much they matter to the dominant question, not by when they were said.",
  "Later statements supersede earlier ones on the same topic. An option explored at length early is often rejected later in a single sentence, and the rejection wins. Where the conversation ends in a decision table or summary, that is authoritative wherever it conflicts with earlier prose.",
  "The input may arrive as numbered compressed slices followed by verbatim recent turns. Slice numbers are chronological: a later slice overrules an earlier one.",
  "Decisions the agent made that the user did not contradict are worth reporting, but user silence only ever yields tentative status.",
  "Do NOT include the agent's self-assessment or any claim that the work is correct or complete — the reviewer must judge that independently.",
  "Every statement must trace to something in the conversation. If a heading has nothing real to report, say so rather than inventing plausible-sounding content.",
  "Write concise markdown bullets under those numbered headings, under 500 words total, in the same language as the conversation. Reply with the brief only.",
].join("\n");

export const REVERSAL_SYSTEM_PROMPT = [
  "You read a coding-agent conversation and report ONLY the conclusions that were later reversed, dropped, or replaced.",
  "A design conversation converges by killing its own hypotheses: an option explored in depth early is often rejected later in one sentence, so weigh finality over how much was written.",
  "A reversal counts whether the user or the agent made it. Ignore rewording that leaves the decision intact.",
  "Output one line per reversal: SUPERSEDED: <what was concluded earlier> -> <what replaced it> (<why>)",
  "Report the most decisive reversals first and stay under 200 words — a list that runs long will be discarded whole, so prioritise rather than pad.",
  "If nothing was reversed, reply with exactly: NONE",
].join("\n");

export const COMPACT_SYSTEM_PROMPT = [
  "You compress one slice of a coding-agent conversation. A later pass will distill the whole thing into an intent brief for a code reviewer.",
  "You are told which slice of how many this is. Other slices are compressed separately and you cannot see them, so never present a conclusion here as final — a later slice may overturn it.",
  "Preserve, in this order of priority:",
  "1. Reversals and corrections — any conclusion that was dropped, replaced, or corrected. Quote the deciding sentence verbatim.",
  "2. Constraints and decisions the user stated, and approaches that were rejected, with the reason. Preserve who made each decision — an explicit user confirmation must stay distinguishable from an agent proposal the user never answered; quote the user's deciding sentence when there is one.",
  "3. Behaviour established by actually running something: observed output, exit codes, error text, which stream an error arrived on.",
  "4. Trade-offs that were acknowledged and accepted.",
  "Drop: exploration narrative, restated background, tool mechanics, and anything a reviewer could recover by reading the code.",
  "Stay under 800 words. An over-long slice is discarded whole rather than cut short, so drop lower-priority material instead of running over.",
  "Keep the conversation's own language. Reply with the compressed slice only, no preamble.",
].join("\n");

/** Scale the request timeout with input size; small inputs keep the old 15s. */
export function timeoutForInput(chars: number): number {
  return Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + Math.floor(chars / 1_000) * TIMEOUT_MS_PER_1K_CHARS);
}

/**
 * True for failures that a smaller prompt would plausibly fix — context-window
 * rejections and timeouts. Everything else (auth, rate limit, network) is
 * fatal: retrying only puts more load on a service that just refused us.
 */
export function isSizeRelatedFailure(error: unknown): boolean {
  const err = error as { name?: string; message?: string };
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  const message = err?.message ?? "";
  return /context[ _-]?length|maximum context|too many tokens|token limit|prompt is too long|request too large|timed? ?out/i.test(
    message,
  );
}

/**
 * Guard for values that feed a later stage. Truncating those is the failure
 * mode this whole module exists to prevent: the tail of a summary is where the
 * last correction lives, and a cut one reads as complete downstream. Over-long
 * mid-pipeline output is discarded, never trimmed.
 */
function withinLimit(text: string, max: number, label: string): boolean {
  if (text.length <= max) return true;
  console.warn(`[ReviewBrief] ${label} ran to ${text.length} chars (limit ${max}) — discarding rather than truncating`);
  return false;
}

/**
 * Cap one message. Unlike mid-pipeline output, a cut here is visible in the
 * prompt itself (the ellipsis tells the model the turn continues), so it is a
 * bound on input volume rather than a silent loss of a conclusion.
 */
function capMessage(text: string): string {
  return text.length > PER_MESSAGE_MAX_CHARS ? text.slice(0, PER_MESSAGE_MAX_CHARS) + "…" : text;
}

interface BriefEntry {
  role: "User" | "Agent";
  text: string;
}

function toEntries(messages: AgentMessage[]): BriefEntry[] {
  const entries: BriefEntry[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.type === "user" && !msg.event) {
      const text = extractUserText(msg.content).trim();
      if (text) entries.push({ role: "User", text: capMessage(text) });
    } else if (msg.type === "assistant" && typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) entries.push({ role: "Agent", text: capMessage(text) });
    }
  }
  return entries;
}

function render(entry: BriefEntry): string {
  return `${entry.role}: ${entry.text}`;
}

function renderAll(entries: BriefEntry[]): string {
  return entries.map(render).join(SEP);
}

/**
 * Flatten a conversation into labeled plain text for distillation. Only user
 * and assistant text carry intent — tool traffic and thinking are noise at
 * this altitude. Harness-injected event notifications (user-typed but not
 * user-written) are skipped. No budget logic lives here: oversized
 * conversations are handled by compactConversation, which summarizes rather
 * than deletes.
 */
export function serializeConversationForBrief(messages: AgentMessage[]): string {
  return renderAll(toEntries(messages));
}

/** Split off the newest entries that fit in `maxChars`, verbatim. */
function splitRecent(entries: BriefEntry[], maxChars: number): { older: BriefEntry[]; recent: BriefEntry[] } {
  let size = 0;
  let i = entries.length;
  while (i > 0) {
    const len = render(entries[i - 1]!).length + SEP.length;
    if (size + len > maxChars) break;
    size += len;
    i--;
  }
  return { older: entries.slice(0, i), recent: entries.slice(i) };
}

/**
 * Group entries into chunks of at most `maxChars`, never splitting a message.
 * A message that alone exceeds the limit gets its own chunk.
 */
function chunkEntries(entries: BriefEntry[], maxChars: number): BriefEntry[][] {
  const chunks: BriefEntry[][] = [];
  let current: BriefEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const len = render(entry).length + SEP.length;
    if (current.length > 0 && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function telemetryFor(functionId: string, userId?: string) {
  return userId
    ? {
        isEnabled: true,
        functionId,
        metadata: { userId, tags: ["vibedeckx", functionId] },
      }
    : undefined;
}

/**
 * Compress one slice. Size failures propagate so the caller can retry with a
 * smaller slice budget; every other failure returns null, which aborts the
 * whole compaction.
 */
async function compactChunk(
  model: AnyLanguageModel,
  chunk: string,
  part: number,
  total: number,
  userId?: string,
): Promise<string | null> {
  try {
    const result = await generateText({
      model,
      system: COMPACT_SYSTEM_PROMPT,
      prompt: `Slice ${part} of ${total}.\n\n${chunk}`,
      timeout: timeoutForInput(chunk.length),
      maxOutputTokens: COMPACT_SUMMARY_MAX_TOKENS,
      experimental_telemetry: telemetryFor("review-intent-brief-compact", userId),
    });
    const { text: rawText, finishReason } = result as { text?: string; finishReason?: string };
    // A token-capped summary lost its tail while staying under the char cap —
    // the same silent-cut failure withinLimit guards against.
    if (finishReason === "length") {
      console.warn(`[ReviewBrief] slice ${part}/${total} summary hit the token cap — discarding`);
      return null;
    }
    const text = (rawText ?? "").trim();
    if (text.length === 0) {
      console.warn(`[ReviewBrief] slice ${part}/${total} came back empty (finishReason: ${finishReason ?? "unknown"})`);
      return null;
    }
    return withinLimit(text, COMPACT_SUMMARY_MAX_CHARS, `slice ${part}/${total} summary`) ? text : null;
  } catch (error) {
    if (isSizeRelatedFailure(error)) throw error;
    console.warn(`[ReviewBrief] compaction of slice ${part}/${total} failed:`, (error as Error).message);
    return null;
  }
}

/**
 * Compress an oversized conversation: summarize the older slices in parallel,
 * keep the newest turns verbatim. The slice count is computed up front from
 * the input size — this never loops until it fits, so it always terminates.
 *
 * Throws size-related failures so the caller can retry with a smaller
 * `sliceChars`. Returns null when the conversation needs more than
 * MAX_FOLD_CALLS slices, or when any slice fails for another reason. A partial
 * compaction would read as complete while silently missing a decision, which
 * is the exact failure this path exists to avoid — better to degrade to tier 2
 * visibly.
 */
export async function compactConversation(
  model: AnyLanguageModel,
  messages: AgentMessage[],
  options: { userId?: string; sliceChars?: number } = {},
): Promise<string | null> {
  const sliceChars = options.sliceChars ?? COMPACT_SLICE_BUDGETS[0]!;
  const recentChars = Math.max(MIN_RECENT_VERBATIM_CHARS, Math.floor(sliceChars * RECENT_VERBATIM_RATIO));

  const entries = toEntries(messages);
  if (entries.length === 0) return null;

  const { older, recent } = splitRecent(entries, recentChars);
  // Nothing older than the verbatim window: there is no smaller version to
  // produce. Say so rather than handing back the same text labeled compacted.
  if (older.length === 0) return null;

  const chunks = chunkEntries(older, sliceChars);
  if (chunks.length > MAX_FOLD_CALLS) {
    console.warn(
      `[ReviewBrief] conversation needs ${chunks.length} slices of ${sliceChars} chars (max ${MAX_FOLD_CALLS}) — falling back to tier 2`,
    );
    return null;
  }

  // allSettled rather than all: a size rejection must not leave the other
  // in-flight calls as unhandled rejections.
  const settled = await Promise.allSettled(
    chunks.map((chunk, i) => compactChunk(model, renderAll(chunk), i + 1, chunks.length, options.userId)),
  );
  const sizeRejection = settled.find((r) => r.status === "rejected" && isSizeRelatedFailure(r.reason));
  if (sizeRejection) throw (sizeRejection as PromiseRejectedResult).reason;
  if (settled.some((r) => r.status === "rejected" || r.value === null)) return null;

  const parts = settled.map(
    (r, i) => `[Compressed slice ${i + 1} of ${chunks.length}]\n${(r as PromiseFulfilledResult<string>).value}`,
  );
  if (recent.length > 0) parts.push(`[Recent turns, verbatim]\n${renderAll(recent)}`);
  return parts.join(SEP);
}

export function buildBriefPrompt(conversation: string, reversals: string | null): string {
  const preamble = reversals
    ? "Conclusions this conversation reversed. The right-hand side is the current state — never report the left-hand side as what was decided:\n" +
      reversals +
      SEP
    : "";
  return `${preamble}Distill this conversation into an intent brief:\n\n${conversation}`;
}

/** Attach the disclaimer when the distiller worked from compacted input. */
export function appendCompactionNote(brief: string, compacted: boolean): string {
  return compacted ? `${brief}${SEP}${COMPACTION_NOTE}` : brief;
}

/**
 * Find conclusions the conversation later overturned, as a short list to
 * prepend to the brief prompt. A single-purpose pass over the whole
 * conversation beats hoping the main pass notices a one-sentence rejection
 * buried mid-context.
 *
 * Null means "no reversals to report" — including when the list came back too
 * long to trust, since a truncated reversal list is worse than none. Size
 * failures also yield null (the main call will hit the same wall and trigger
 * compaction); fatal failures propagate so the caller stops rather than firing
 * a second doomed request.
 */
export async function extractReversalsWithModel(
  model: AnyLanguageModel,
  conversation: string,
  options: { userId?: string } = {},
): Promise<string | null> {
  if (conversation.trim().length < REVERSAL_MIN_CHARS) return null;

  try {
    const result = await generateText({
      model,
      system: REVERSAL_SYSTEM_PROMPT,
      prompt: `Report the reversals in this conversation:\n\n${conversation}`,
      timeout: JUDGMENT_TIMEOUT_MS,
      maxOutputTokens: REVERSALS_MAX_TOKENS,
      experimental_telemetry: telemetryFor("review-intent-brief-reversals", options.userId),
    });

    const { text: rawText, finishReason } = result as { text?: string; finishReason?: string };
    // A token-capped list looks authoritative while missing whichever reversal
    // came last — same rule as the char-cap guard below: discard, never cut.
    if (finishReason === "length") {
      console.warn("[ReviewBrief] reversal list hit the token cap — discarding");
      return null;
    }
    const text = (rawText ?? "").trim();
    if (text.length === 0 || /^none\b/i.test(text)) return null;
    return withinLimit(text, REVERSALS_MAX_CHARS, "reversal list") ? text : null;
  } catch (error) {
    if (!isSizeRelatedFailure(error)) throw error;
    console.warn("[ReviewBrief] reversal pass hit a size limit — skipping it:", (error as Error).message);
    return null;
  }
}

/**
 * Run the brief-distillation prompt against any AI SDK language model.
 * Returns null on failure or empty output — callers fall back to the
 * deterministic excerpt (tier 2).
 *
 * `rethrowSizeFailures` lets the orchestrator see context-overflow and timeout
 * errors so it can retry against a compacted conversation; every other caller
 * keeps the swallow-and-return-null contract.
 */
export async function generateIntentBriefWithModel(
  model: AnyLanguageModel,
  conversation: string,
  options: { userId?: string; reversals?: string | null; rethrowSizeFailures?: boolean } = {},
): Promise<string | null> {
  if (conversation.trim().length === 0) return null;

  try {
    // Native SDK timeout: aborts the underlying request on expiry (a
    // Promise.race would only detach from it, leaving the model generating
    // billable tokens in the background) and leaves no dangling timer.
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildBriefPrompt(conversation, options.reversals ?? null),
      timeout: JUDGMENT_TIMEOUT_MS,
      maxOutputTokens: BRIEF_MAX_TOKENS,
      experimental_telemetry: telemetryFor("review-intent-brief", options.userId),
    });

    const { text: rawText, finishReason } = result as { text?: string; finishReason?: string };
    const text = (rawText ?? "").trim();
    if (text.length === 0) {
      // Seen live: a reasoning model can burn the whole token budget thinking
      // and emit no text at all. Name the finish reason — a warn-less null
      // here cost a full eval round to diagnose.
      console.warn(`[ReviewBrief] model returned empty text (finishReason: ${finishReason ?? "unknown"})`);
      return null;
    }
    // A maxOutputTokens cut can land under the char cap: the brief reads as
    // complete but lost its tail. The brief is terminal output, so mark the
    // cut visibly (mid-pipeline stages discard instead).
    if (finishReason === "length") return text.slice(0, BRIEF_MAX_CHARS) + BRIEF_TRUNCATION_NOTE;
    return text.length <= BRIEF_MAX_CHARS ? text : text.slice(0, BRIEF_MAX_CHARS) + BRIEF_TRUNCATION_NOTE;
  } catch (error) {
    if (options.rethrowSizeFailures && isSizeRelatedFailure(error)) throw error;
    console.warn("[ReviewBrief] AI generation failed:", (error as Error).message);
    return null;
  }
}

async function distill(
  model: AnyLanguageModel,
  conversation: string,
  userId: string,
  rethrowSizeFailures: boolean,
): Promise<string | null> {
  const reversals = await extractReversalsWithModel(model, conversation, { userId });
  return generateIntentBriefWithModel(model, conversation, { userId, reversals, rethrowSizeFailures });
}

/**
 * Distill a source session's conversation into an intent brief. Judgment calls
 * use the configured MAIN chat model (falling back to the fast lane when main
 * has no key); slice compression uses the fast model.
 *
 * Optimistic-first: send the whole conversation and let the model tell us it
 * is too big, rather than guessing a budget for a model the user configured
 * and we cannot introspect. When it does refuse, walk down
 * COMPACT_SLICE_BUDGETS — each retry compresses in smaller slices, so a 32k
 * model converges instead of failing the same way three times.
 *
 * Null on any failure or when no model is configured — never throws, so review
 * start degrades to the deterministic excerpt (tier 2) silently.
 */
export async function generateIntentBrief(
  storage: Storage,
  userId: string,
  messages: AgentMessage[],
): Promise<string | null> {
  try {
    const config = await getChatProviderConfig(storage, userId);
    const mainOk = isModelConfigured(config, config.main);
    const fastOk = isModelConfigured(config, config.fast);
    if (!mainOk && !fastOk) return null;
    const conversation = serializeConversationForBrief(messages);
    if (!conversation) return null;

    // Judgment (reversal + brief) runs on the strongest configured lane —
    // weighing importance (dominant question, settled vs tentative) is exactly
    // where the fast lane is weakest, and it is one call per review start.
    // Mechanical slice compression stays on the fast lane: up to MAX_FOLD_CALLS
    // parallel calls, and compression needs recall, not judgment.
    const distillModel = mainOk ? await resolveChatModel(storage, userId) : await resolveFastChatModel(storage, userId);
    const compactModel = fastOk ? await resolveFastChatModel(storage, userId) : distillModel;

    if (conversation.length <= COMPACT_TRIGGER_CHARS) {
      try {
        const brief = await distill(distillModel, conversation, userId, true);
        return brief === null ? null : appendCompactionNote(brief, false);
      } catch (error) {
        if (!isSizeRelatedFailure(error)) throw error;
        console.warn("[ReviewBrief] full conversation rejected as too large — compacting and retrying");
      }
    }

    for (const sliceChars of COMPACT_SLICE_BUDGETS) {
      try {
        const compacted = await compactConversation(compactModel, messages, { userId, sliceChars });
        if (compacted === null) return null;
        const brief = await distill(distillModel, compacted, userId, true);
        return brief === null ? null : appendCompactionNote(brief, true);
      } catch (error) {
        if (!isSizeRelatedFailure(error)) throw error;
        console.warn(`[ReviewBrief] ${sliceChars}-char slices still too large — retrying smaller`);
      }
    }

    console.warn("[ReviewBrief] could not compact the conversation small enough — falling back to tier 2");
    return null;
  } catch (error) {
    console.warn("[ReviewBrief] generation failed:", (error as Error).message);
    return null;
  }
}
