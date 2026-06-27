import { type BundledLanguage, codeToTokensBase } from "shiki";

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

// Tokenize a file with Shiki and classify each token by its scopes. This is the
// shared foundation for symbol-only clicks (this module) and, later, code
// folding. Theme is irrelevant to classification — scopes come from the grammar,
// not the theme — so any theme works.
export async function tokenizeFile(
  code: string,
  language: BundledLanguage
): Promise<SymbolTokenIndex> {
  const lines = await codeToTokensBase(code, {
    lang: language,
    theme: "one-light",
    includeExplanation: "scopeName",
  });

  const index: SymbolTokenIndex = new Map();
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
    index.set(i + 1, classified);
  });
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
