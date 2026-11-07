import { describe, expect, it } from "vitest";
import { PreviewAuth, parseCookieHeader, stripPreviewCookies } from "./preview-auth.js";

/** docs/preview-links-design.md §Auth */
describe("PreviewAuth", () => {
  const make = () => {
    let now = 1_000_000;
    const auth = new PreviewAuth(async () => "secret", () => now);
    return { auth, advance: (ms: number) => { now += ms; } };
  };

  it("tickets are single-use, slug-bound and short-lived", () => {
    const { auth, advance } = make();
    const t = auth.mintTicket("k7f2qa", "user-1");
    expect(auth.consumeTicket(t, "other")).toBeNull();
    const t2 = auth.mintTicket("k7f2qa", "user-1");
    expect(auth.consumeTicket(t2, "k7f2qa")).toEqual({ userId: "user-1" });
    expect(auth.consumeTicket(t2, "k7f2qa")).toBeNull();
    const t3 = auth.mintTicket("k7f2qa", "user-1");
    advance(61_000);
    expect(auth.consumeTicket(t3, "k7f2qa")).toBeNull();
    expect(auth.consumeTicket("nonsense", "k7f2qa")).toBeNull();
  });

  it("cookies vouch for one user on one slug until they expire", async () => {
    const { auth, advance } = make();
    const value = await auth.issueCookieValue("k7f2qa", "user-1");
    expect(await auth.verifyCookieValue(value, "k7f2qa")).toBe("user-1");
    expect(await auth.verifyCookieValue(value, "zzzzzz")).toBeNull();
    expect(await auth.verifyCookieValue(`${value}x`, "k7f2qa")).toBeNull();
    expect(await auth.verifyCookieValue(undefined, "k7f2qa")).toBeNull();
    advance(13 * 60 * 60 * 1000);
    expect(await auth.verifyCookieValue(value, "k7f2qa")).toBeNull();
  });

  it("a cookie signed with another hub's secret is rejected", async () => {
    const a = new PreviewAuth(async () => "secret-a");
    const b = new PreviewAuth(async () => "secret-b");
    const value = await a.issueCookieValue("k7f2qa", "user-1");
    expect(await b.verifyCookieValue(value, "k7f2qa")).toBeNull();
  });
});

describe("cookie header helpers", () => {
  it("parses and strips only our cookies", () => {
    const header = "vdx_preview=abc.def; theme=dark; vdx_other=1; session=xyz";
    expect(parseCookieHeader(header).get("vdx_preview")).toBe("abc.def");
    expect(stripPreviewCookies(header)).toBe("theme=dark; session=xyz");
    expect(stripPreviewCookies("vdx_preview=only")).toBeUndefined();
    expect(stripPreviewCookies(undefined)).toBeUndefined();
  });
});
