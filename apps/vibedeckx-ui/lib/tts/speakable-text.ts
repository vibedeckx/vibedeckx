import { marked, type Token, type Tokens } from "marked";

/**
 * Markdown → text worth hearing. Markup is dropped (no "star star"), code
 * blocks are announced rather than read ("一段 12 行的 TypeScript 代码"),
 * tables are read row by row, links read as their text, and inline HTML —
 * including our own markers like <vfile/> — disappears.
 * Blocks are separated by "\n" so the chunker can split on them.
 */

type Lang = "zh" | "en";

const CJK_RE = /[㐀-鿿豈-﫿]/g;
const LETTER_RE = /[A-Za-z㐀-鿿豈-﫿]/g;
const END_PUNCT_RE = /[。！？!?.…:：;；]$/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** Chinese phrasing when CJK makes up a meaningful share of the prose. */
export function detectLang(prose: string): Lang {
  const letters = prose.match(LETTER_RE)?.length ?? 0;
  const cjk = prose.match(CJK_RE)?.length ?? 0;
  return letters > 0 && cjk / letters >= 0.2 ? "zh" : "en";
}

function isBareUrl(link: Tokens.Link): boolean {
  return link.text === link.href || /^(https?:|mailto:|www\.)/i.test(link.text);
}

function inline(tokens: Token[] | undefined, lang: Lang): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        out += "tokens" in token && token.tokens ? inline(token.tokens, lang) : decodeEntities(token.text);
        break;
      case "escape":
        out += token.text;
        break;
      case "codespan":
        // Usually a file, command or identifier — worth saying, minus backticks.
        out += decodeEntities(token.text);
        break;
      case "strong":
      case "em":
      case "del":
        out += inline(token.tokens, lang);
        break;
      case "link":
        out += isBareUrl(token as Tokens.Link) ? (lang === "zh" ? "链接" : "link") : inline(token.tokens, lang);
        break;
      case "br":
        out += " ";
        break;
      // image, html (incl. <vfile/>, <vremotes>…), and anything unknown: silent.
      default:
        break;
    }
  }
  return out;
}

function sentence(text: string, lang: Lang): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return END_PUNCT_RE.test(trimmed) ? trimmed : trimmed + (lang === "zh" ? "。" : ".");
}

function describeCode(code: Tokens.Code, lang: Lang): string {
  const lines = code.text.replace(/\n+$/, "").split("\n").length;
  const language = (code.lang ?? "").trim().split(/\s+/)[0];
  const label = language ? prettyLanguage(language) : "";
  if (lang === "zh") return label ? `一段 ${lines} 行的 ${label} 代码。` : `一段 ${lines} 行的代码。`;
  const unit = lines === 1 ? "line" : "lines";
  return label ? `${label} code block, ${lines} ${unit}.` : `Code block, ${lines} ${unit}.`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  py: "Python",
  python: "Python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
  markdown: "Markdown",
  go: "Go",
  rs: "Rust",
  rust: "Rust",
  diff: "diff",
};

function prettyLanguage(lang: string): string {
  return LANGUAGE_NAMES[lang.toLowerCase()] ?? lang;
}

interface Ctx {
  lang: Lang;
  /** false → skip code blocks entirely instead of announcing them. */
  announceCode: boolean;
}

function blocks(tokens: Token[], ctx: Ctx, out: string[]): void {
  const { lang } = ctx;
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
      case "paragraph":
        out.push(sentence(inline(token.tokens, lang), lang));
        break;
      case "text":
        // Block-level text inside tight list items.
        out.push(sentence("tokens" in token && token.tokens ? inline(token.tokens, lang) : decodeEntities(token.text), lang));
        break;
      case "code":
        if (ctx.announceCode) out.push(describeCode(token as Tokens.Code, lang));
        break;
      case "blockquote":
        blocks(token.tokens ?? [], ctx, out);
        break;
      case "list":
        for (const item of (token as Tokens.List).items) blocks(item.tokens, ctx, out);
        break;
      case "table": {
        const table = token as Tokens.Table;
        const sep = lang === "zh" ? "，" : ", ";
        for (const row of [table.header, ...table.rows]) {
          out.push(sentence(row.map((cell) => inline(cell.tokens, lang).trim()).filter(Boolean).join(sep), lang));
        }
        break;
      }
      // hr, space, html blocks, def: silent.
      default:
        break;
    }
  }
}

function render(markdown: string, announceCode: boolean): string {
  if (!markdown.trim()) return "";
  const tokens = marked.lexer(markdown, { gfm: true });
  // Decide phrasing from the prose alone — code would skew it towards English.
  const prose = markdown.replace(/```[\s\S]*?(```|$)/g, " ");
  const out: string[] = [];
  blocks(tokens, { lang: detectLang(prose), announceCode }, out);
  return out.filter(Boolean).join("\n");
}

export function toSpeakableText(markdown: string): string {
  return render(markdown, true);
}

/**
 * Whether there is prose worth reading. Code announcements don't count: a
 * reply that is only a code block would be read as just "Shell code block,
 * 1 line", which is noise, so it gets no read-aloud button.
 */
export function hasSpeakableContent(markdown: string): boolean {
  return render(markdown, false).length > 0;
}
