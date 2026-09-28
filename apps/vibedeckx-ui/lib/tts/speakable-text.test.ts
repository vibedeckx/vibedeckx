import { describe, it, expect } from "vitest";
import { toSpeakableText, detectLang, hasSpeakableContent } from "./speakable-text";

describe("toSpeakableText", () => {
  it("drops markup and keeps the words", () => {
    expect(toSpeakableText("# Summary\n\nThis is **bold** and _em_ and ~~gone~~ text")).toBe(
      "Summary.\nThis is bold and em and gone text.",
    );
  });

  it("announces code blocks in Chinese with language and line count", () => {
    const md = "修改如下：\n\n```ts\nconst a = 1;\nconst b = 2;\n\n```\n\n完成了。";
    expect(toSpeakableText(md)).toBe("修改如下：\n一段 2 行的 TypeScript 代码。\n完成了。");
  });

  it("announces code blocks in English, with and without a language", () => {
    expect(toSpeakableText("Run this:\n\n```\nls\n```")).toBe("Run this:\nCode block, 1 line.");
    expect(toSpeakableText("Here:\n\n```python\na\nb\nc\n```")).toBe("Here:\nPython code block, 3 lines.");
  });

  it("keeps inline code text, link text, and names bare URLs", () => {
    expect(toSpeakableText("Edit `src/a.ts` per [the guide](docs/x.md) at https://example.com/x")).toBe(
      "Edit src/a.ts per the guide at link.",
    );
    expect(toSpeakableText("详见 https://example.com 这里的说明文档")).toBe("详见 链接 这里的说明文档。");
  });

  it("reads tables row by row", () => {
    const md = "| 文件 | 状态 |\n|---|---|\n| a.ts | 已改 |\n| b.ts | 未改 |";
    expect(toSpeakableText(md)).toBe("文件，状态。\na.ts，已改。\nb.ts，未改。");
  });

  it("reads list items as sentences and nested lists too", () => {
    expect(toSpeakableText("- first\n- second\n  - nested")).toBe("first.\nsecond.\nnested.");
  });

  it("drops html and internal markers, decodes entities", () => {
    expect(toSpeakableText('See <vfile path="/tmp/x.txt"/> for 5 &lt; 6 &amp; more')).toBe("See for 5 < 6 & more.");
  });

  it("returns empty for code-only or blank input", () => {
    expect(toSpeakableText("   ")).toBe("");
    expect(toSpeakableText("<br/>")).toBe("");
  });

  it("treats code-only replies as having nothing to say", () => {
    expect(hasSpeakableContent("```bash\nls\n```")).toBe(false);
    expect(hasSpeakableContent("<br/>")).toBe(false);
    expect(hasSpeakableContent("Run:\n\n```bash\nls\n```")).toBe(true);
  });

  it("detects language from prose share", () => {
    expect(detectLang("这是一个 test")).toBe("zh");
    expect(detectLang("This is mostly English 的")).toBe("en");
  });
});
