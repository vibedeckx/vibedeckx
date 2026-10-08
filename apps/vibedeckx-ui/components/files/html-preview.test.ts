import { describe, expect, it } from "vitest";
import { withSrcdocBase } from "./html-preview";

const BASE = '<base href="about:srcdoc">';

describe("withSrcdocBase", () => {
  it("puts the base first inside <head>, ahead of the page's own <base>", () => {
    const html = '<!doctype html><html><head lang="en"><base href="https://cdn.example/"><title>t</title></head></html>';
    expect(withSrcdocBase(html)).toBe(
      `<!doctype html><html><head lang="en">${BASE}<base href="https://cdn.example/"><title>t</title></head></html>`,
    );
  });

  it("goes after a leading doctype when there is no <head>, to stay out of quirks mode", () => {
    expect(withSrcdocBase("  <!DOCTYPE html>\n<p>hi</p>")).toBe(`  <!DOCTYPE html>${BASE}\n<p>hi</p>`);
  });

  it("is prepended to a bare fragment", () => {
    expect(withSrcdocBase('<a href="#x">x</a>')).toBe(`${BASE}<a href="#x">x</a>`);
  });

  it("does not mistake <header> for <head>", () => {
    expect(withSrcdocBase("<header>h</header>")).toBe(`${BASE}<header>h</header>`);
  });
});
