import { afterEach, describe, expect, it } from "vitest";
import { buildTitlePromptForTest, extractTitleSource, snippetTitle, snippetTitleFromSource } from "./conversation-title.js";

const SEP = "\n\n<<<vibedeckx:attached-context>>>\n\n";
import {
  clearTitleExcerptCache,
  getTitleExcerpt,
  rememberTitleExcerpt,
  textExcerptFromBytes,
  TITLE_EXCERPT_MAX_CHARS,
} from "./title-excerpt-cache.js";

const tasksBlock = [
  `<vselected-tasks note="Tasks the user selected">`,
  `<task id="t1" title="Fix &quot;login&quot; redirect" status="todo" priority="high">`,
  "Users land on /home instead of the page they came from.",
  `<subtask id="t2" title="Add test" status="todo" />`,
  "</task>",
  `<task id="t3" title="Empty one" status="todo" priority="low">`,
  "(no description)",
  "</task>",
  "</vselected-tasks>",
].join("\n");

afterEach(() => clearTitleExcerptCache());

describe("extractTitleSource", () => {
  it("keeps selected tasks' titles and descriptions instead of dropping the block", () => {
    const source = extractTitleSource(`查看任务\n\n${tasksBlock}`);
    expect(source).toContain("查看任务");
    expect(source).toContain(`[Task: Fix "login" redirect]\nUsers land on /home instead of the page they came from.`);
    expect(source).toContain("[Task: Empty one]");
    expect(source).not.toContain("no description");
    expect(source).not.toContain("subtask");
    expect(source).not.toContain("vselected-tasks");
  });

  it("replaces paste and file markers with their recorded excerpts", () => {
    rememberTitleExcerpt("u1", "/tmp/p/a.txt", "Stack trace: TypeError at parseConfig");
    rememberTitleExcerpt("u1", "/tmp/f/x/notes.md", "# Q3 migration plan");
    const source = extractTitleSource([
      { type: "text", text: `看看这个 <vpaste path="/tmp/p/a.txt" size="40" />` },
      { type: "text", text: `<vfile path="/tmp/f/x/notes.md" name="notes.md" size="20" />` },
    ]);
    expect(source).toBe(
      `看看这个${SEP}[Pasted text]\nStack trace: TypeError at parseConfig\n\n[Attached file: notes.md]\n# Q3 migration plan`,
    );
  });

  it("falls back to the label when no excerpt was recorded", () => {
    const source = extractTitleSource(`<vfile path="/tmp/f/y/report.pdf" name="report.pdf" size="9000" />`);
    expect(source).toBe(`${SEP}[Attached file: report.pdf]`);
  });

  it("still strips machine-addressed blocks", () => {
    const source = extractTitleSource(`hello\n<vremotes names="a">ctx</vremotes>`);
    expect(source).toBe("hello");
  });

  it("splits the context budget across pieces", () => {
    const long = "x".repeat(TITLE_EXCERPT_MAX_CHARS);
    for (let i = 0; i < 4; i++) rememberTitleExcerpt("u1", `/p/${i}`, long);
    const markers = [0, 1, 2, 3].map((i) => `<vpaste path="/p/${i}" size="1" />`).join(" ");
    const source = extractTitleSource(markers);
    expect(source.length).toBeLessThan(1800);
    expect(source.match(/\[Pasted text\]/g)).toHaveLength(4);
  });
});

describe("title excerpt cache", () => {
  it("caps each owner at 20 entries, evicting only that owner's oldest", () => {
    rememberTitleExcerpt("victim", "/v", "victim's paste");
    for (let i = 0; i < 25; i++) rememberTitleExcerpt("flooder", `/f/${i}`, `paste ${i}`);
    expect(getTitleExcerpt("/v")).toBe("victim's paste");
    expect(getTitleExcerpt("/f/4")).toBeNull();
    expect(getTitleExcerpt("/f/5")).toBe("paste 5");
    expect(getTitleExcerpt("/f/24")).toBe("paste 24");
  });

  it("keeps only the head of a huge paste", () => {
    rememberTitleExcerpt("u1", "/big", "a ".repeat(5_000_000));
    expect(getTitleExcerpt("/big")).toHaveLength(TITLE_EXCERPT_MAX_CHARS);
  });
});

describe("textExcerptFromBytes", () => {
  it("returns the head of a UTF-8 text file, whitespace collapsed", () => {
    expect(textExcerptFromBytes(Buffer.from("第一行\n\n  second   line\n"))).toBe("第一行 second line");
  });

  it("rejects binary content", () => {
    expect(textExcerptFromBytes(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toBeNull();
    expect(textExcerptFromBytes(Buffer.from(Array.from({ length: 500 }, (_, i) => 0x80 + (i % 64))))).toBeNull();
  });

  it("tolerates a multibyte character split at the sniff boundary", () => {
    const text = "汉".repeat(5000); // 15 000 bytes, cut at 8 KB mid-character
    expect(textExcerptFromBytes(Buffer.from(text))).toBe("汉".repeat(TITLE_EXCERPT_MAX_CHARS));
  });
});

describe("title prompt", () => {
  it("keeps a plain message in the original single-section prompt", () => {
    expect(buildTitlePromptForTest("fix the flaky test")).toBe(
      "Generate a title for a conversation that begins with this user message:\n\nfix the flaky test",
    );
  });

  it("presents the user's words and the attached context as separate sections", () => {
    const prompt = buildTitlePromptForTest(extractTitleSource(`把这个翻译成英文\n\n${tasksBlock}`));
    expect(prompt).toMatch(/User's message:\n把这个翻译成英文\n\nAttached context \(reference material[^\n]*\n\[Task: Fix "login" redirect\]/);
    expect(prompt).not.toContain("<<<vibedeckx");
  });

  it("says so when the user sent only the attached context", () => {
    expect(buildTitlePromptForTest(`${SEP}[Pasted text]\nhello`)).toContain(
      "User's message:\n(none — the user sent only the attached context)",
    );
  });
});

describe("snippetTitleFromSource", () => {
  it("prefers the user's words, falling back to the context", () => {
    expect(snippetTitleFromSource(`看看${SEP}[Task: X]\nbody`)).toBe("看看");
    expect(snippetTitleFromSource(`${SEP}[Task: X]\nbody`)).toBe("[Task: X] body");
    expect(snippetTitleFromSource("plain")).toBe("plain");
  });
});

describe("snippetTitle", () => {
  it("collapses newlines so a context-bearing fallback stays one line", () => {
    expect(snippetTitle("看看\n\n[Task: X]")).toBe("看看 [Task: X]");
  });
});
