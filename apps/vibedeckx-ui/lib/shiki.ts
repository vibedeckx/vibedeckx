// Our own Shiki instance (the Files preview + symbol classification; chat code
// blocks go through streamdown's separate instance). Built on `shiki/core` with
// the JavaScript regex engine and per-language lazy loading, instead of the
// `shiki` bundle entry: that entry statically pulls every grammar plus the
// Oniguruma WASM engine (~600KB raw) — one 5s download on a slow link, paid on
// every page load because the Files panel restores the last-opened file.
//
// Everything here is loaded on first use (core + engine + themes ≈ 50KB gz,
// then one grammar chunk per language as it is first opened), and nothing
// lands in the first-load bundle.
import type { HighlighterCore } from "shiki/core";

// Language id → grammar loader. Each `import()` literal becomes its own chunk,
// fetched the first time that language is highlighted. A `@shikijs/langs/<id>`
// module's default export already includes the grammars it embeds eagerly
// (vue → html/css/js/ts), so one load is enough. Grammars a language embeds
// only lazily (markdown's fenced-block languages) are NOT pulled in — those
// blocks render as plain text unless that language was loaded on its own.
//
// The set is "what the Files panel can show": the file-preview extension map
// must only produce keys of this table (enforced by its value type), plus
// "text" for everything else, which loads no grammar at all.
const LANG_LOADERS = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
} as const;

export type SupportedLanguage = keyof typeof LANG_LOADERS | "text";

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return lang === "text" || Object.prototype.hasOwnProperty.call(LANG_LOADERS, lang);
}

export const THEMES = { light: "one-light", dark: "one-dark-pro" } as const;

let highlighterPromise: Promise<HighlighterCore> | null = null;
// Per-language load promise: concurrent first uses of one language (preview +
// symbol tokenizer fire together) share a single grammar fetch.
const langLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("@shikijs/themes/one-light"),
        import("@shikijs/themes/one-dark-pro"),
      ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      // `forgiving`: a grammar pattern the Oniguruma→JS translation can't
      // express degrades to "no match" instead of throwing for the whole file.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })().catch((err) => {
    highlighterPromise = null; // let a later call retry after a transient failure
    throw err;
  });
  return highlighterPromise;
}

// Resolve a highlighter with `lang` loaded (no-op for "text").
export async function getHighlighterFor(lang: SupportedLanguage): Promise<HighlighterCore> {
  const hl = await getHighlighter();
  if (lang === "text") return hl;
  let load = langLoads.get(lang);
  if (!load) {
    load = LANG_LOADERS[lang]()
      .then((mod) => hl.loadLanguage(mod.default))
      .catch((err) => {
        langLoads.delete(lang);
        throw err;
      });
    langLoads.set(lang, load);
  }
  await load;
  return hl;
}

/** Test-only: forget the singleton so a test can observe a cold start. */
export function resetShikiForTests(): void {
  highlighterPromise = null;
  langLoads.clear();
}
