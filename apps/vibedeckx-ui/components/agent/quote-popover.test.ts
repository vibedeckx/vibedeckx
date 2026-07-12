import { describe, expect, it } from "vitest";

import { appendQuote } from "./quote-popover";

describe("appendQuote", () => {
  it("formats a quote in an empty input", () => {
    expect(appendQuote("", "first")).toBe("> first\n\n");
  });

  it("separates a quote from existing input with a blank line", () => {
    expect(appendQuote("draft", "first")).toBe("draft\n\n> first\n\n");
    expect(appendQuote("draft\n", "first")).toBe("draft\n\n> first\n\n");
    expect(appendQuote("draft\n\n", "first")).toBe("draft\n\n> first\n\n");
  });

  it("keeps repeated quotes in selection order", () => {
    const first = appendQuote("", "first");

    expect(appendQuote(first, "second")).toBe("> first\n\n> second\n\n");
  });
});
