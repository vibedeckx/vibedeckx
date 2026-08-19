import { afterEach, describe, expect, it } from "vitest";
import { getHighlighterFor, isSupportedLanguage, resetShikiForTests, THEMES } from "./shiki";

afterEach(() => resetShikiForTests());

describe("lib/shiki (core + JS regex engine + lazy grammars)", () => {
  it("highlights with a lazily loaded grammar and both themes", async () => {
    const hl = await getHighlighterFor("typescript");
    const html = hl.codeToHtml("const a: number = 1", { lang: "typescript", theme: THEMES.dark });
    expect(html).toContain("<pre");
    expect(html).toContain("const");
    expect(hl.getLoadedLanguages()).toContain("typescript");
    expect(hl.getLoadedThemes().sort()).toEqual([THEMES.dark, THEMES.light].sort());
  });

  it('"text" loads no grammar', async () => {
    const hl = await getHighlighterFor("text");
    expect(hl.getLoadedLanguages()).toEqual([]);
    // plain-text rendering still works
    expect(hl.codeToHtml("hello", { lang: "text", theme: THEMES.light })).toContain("hello");
  });

  it("loads each grammar once even under concurrent first use", async () => {
    const [a, b] = await Promise.all([getHighlighterFor("python"), getHighlighterFor("python")]);
    expect(a).toBe(b);
    expect(a.getLoadedLanguages().filter((l) => l === "python")).toHaveLength(1);
  });

  it("embedded grammars ride along with their host (vue → html/css/js/ts)", async () => {
    const hl = await getHighlighterFor("vue");
    const loaded = hl.getLoadedLanguages();
    for (const l of ["vue", "html", "css", "javascript", "typescript"]) expect(loaded).toContain(l);
  });

  it("isSupportedLanguage guards unknown ids", () => {
    expect(isSupportedLanguage("typescript")).toBe(true);
    expect(isSupportedLanguage("text")).toBe(true);
    expect(isSupportedLanguage("brainfuck")).toBe(false);
  });
});
