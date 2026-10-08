import { getHighlighterFor, THEMES, type SupportedLanguage } from "@/lib/shiki";
import type { GrammarState } from "shiki/core";

// What kind of token sits under a click. Only "code" tokens are real symbols
// worth a definition/reference lookup; the rest are noise the popover should
// not open on (a word inside a comment/string, or a language keyword).
export type TokenKind = "code" | "comment" | "string" | "keyword";

interface ClassifiedToken {
  // Column offsets within the source line, 0-based, end exclusive.
  start: number;
  end: number;
  kind: TokenKind;
}

// 1-based source line number → that line's classified tokens, in order.
export type SymbolTokenIndex = Map<number, ClassifiedToken[]>;

// Decide a token's kind from its TextMate scopes. We only ever EXCLUDE
// clearly-non-symbol tokens — comments, strings, and language keywords (incl.
// `storage`/`constant.language`/`variable.language`, which is how grammars tag
// const/let/function/class/true/this). Everything else (identifiers, function
// names, type references, properties) stays "code" and remains clickable.
function classifyScopes(scopes: string[]): TokenKind {
  if (scopes.some((s) => s.startsWith("comment"))) return "comment";
  if (scopes.some((s) => s.startsWith("string") || s.startsWith("constant.character")))
    return "string";
  if (
    scopes.some(
      (s) =>
        s.startsWith("keyword") ||
        s.startsWith("storage") ||
        s.startsWith("constant.language") ||
        s.startsWith("variable.language")
    )
  )
    return "keyword";
  return "code";
}

// Lines tokenized per slice before yielding back to the event loop.
const TOKENIZE_CHUNK_LINES = 200;

// Tokenize a file with Shiki and classify each token by its scopes. This is the
// shared foundation for symbol-only clicks (this module) and, later, code
// folding. Theme is irrelevant to classification — scopes come from the grammar,
// not the theme — so any theme works.
//
// Shiki is synchronous and slow on big files (seconds for ~100KB of TS), so the
// file is tokenized in slices — the grammar state carries the context (an open
// comment, an embedded <script>) across each boundary — yielding between them so
// the page stays responsive. Abort `signal` to stop early (the file changed).
export async function tokenizeFile(
  code: string,
  language: SupportedLanguage,
  signal?: AbortSignal
): Promise<SymbolTokenIndex> {
  const highlighter = await getHighlighterFor(language);
  const sourceLines = code.split("\n");
  const index: SymbolTokenIndex = new Map();
  let grammarState: GrammarState | undefined;

  for (let first = 0; first < sourceLines.length; first += TOKENIZE_CHUNK_LINES) {
    if (first > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    // Checked before every slice — the first included, since the request may
    // have been aborted while the grammar was loading.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const lines = highlighter.codeToTokensBase(
      sourceLines.slice(first, first + TOKENIZE_CHUNK_LINES).join("\n"),
      {
        lang: language,
        theme: THEMES.light,
        includeExplanation: "scopeName",
        grammarState,
      }
    );
    grammarState = highlighter.getLastGrammarState(lines);

    lines.forEach((lineTokens, i) => {
      let col = 0;
      const classified: ClassifiedToken[] = [];
      for (const token of lineTokens) {
        const scopes = (token.explanation ?? []).flatMap((e) =>
          e.scopes.map((s) => s.scopeName)
        );
        const end = col + token.content.length;
        classified.push({ start: col, end, kind: classifyScopes(scopes) });
        col = end;
      }
      index.set(first + i + 1, classified);
    });
  }
  return index;
}

// Kind of the token covering `col` (0-based source column) on `line` (1-based),
// or null if the line/column isn't covered (e.g. index not built for that line).
export function classifyColumn(
  index: SymbolTokenIndex,
  line: number,
  col: number
): TokenKind | null {
  const tokens = index.get(line);
  if (!tokens) return null;
  for (const token of tokens) {
    if (col >= token.start && col < token.end) return token.kind;
  }
  return null;
}
