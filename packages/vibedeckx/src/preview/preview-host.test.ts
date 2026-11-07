import { describe, expect, it } from "vitest";
import { previewOrigin, previewSlugFromHost, resolvePreviewHostConfig } from "./preview-host.js";

/** docs/preview-links-design.md §Host configuration */
describe("resolvePreviewHostConfig", () => {
  it("defaults solo mode to preview.localhost on the listen port", () => {
    expect(resolvePreviewHostConfig({ value: undefined, authEnabled: false, tls: false, publicUrl: undefined, listenPort: 5173 }))
      .toEqual({ hostname: "preview.localhost", port: 5173, scheme: "http" });
  });

  it("fails closed under --auth without a value", () => {
    expect(resolvePreviewHostConfig({ value: undefined, authEnabled: true, tls: true, publicUrl: undefined, listenPort: 8444 })).toBeNull();
    expect(resolvePreviewHostConfig({ value: "  ", authEnabled: true, tls: true, publicUrl: undefined, listenPort: 8444 })).toBeNull();
  });

  it("takes the scheme from the public URL and drops default ports", () => {
    expect(resolvePreviewHostConfig({ value: "vdxpreview.dev", authEnabled: true, tls: false, publicUrl: "https://app.example.com", listenPort: 8444 }))
      .toEqual({ hostname: "vdxpreview.dev", port: null, scheme: "https" });
    expect(resolvePreviewHostConfig({ value: "https://VDXPreview.dev:443/", authEnabled: true, tls: true, publicUrl: undefined, listenPort: 8444 }))
      .toEqual({ hostname: "vdxpreview.dev", port: null, scheme: "https" });
    // Under plain http, 443 is just a port.
    expect(resolvePreviewHostConfig({ value: "vdxpreview.dev:443", authEnabled: true, tls: false, publicUrl: undefined, listenPort: 8444 }))
      .toEqual({ hostname: "vdxpreview.dev", port: 443, scheme: "http" });
    expect(resolvePreviewHostConfig({ value: "preview.localhost:3100", authEnabled: false, tls: false, publicUrl: undefined, listenPort: 5173 }))
      .toEqual({ hostname: "preview.localhost", port: 3100, scheme: "http" });
  });

  it("rejects wildcards, paths and bad ports", () => {
    const base = { authEnabled: true, tls: false, publicUrl: undefined, listenPort: 1 };
    expect(() => resolvePreviewHostConfig({ ...base, value: "*.vdxpreview.dev" })).toThrow(/not a hostname/);
    expect(() => resolvePreviewHostConfig({ ...base, value: "vdxpreview.dev/preview" })).toThrow(/not a hostname/);
    expect(() => resolvePreviewHostConfig({ ...base, value: "vdxpreview.dev:99999" })).toThrow(/bad port/);
    expect(() => resolvePreviewHostConfig({ ...base, value: "a:b:c" })).toThrow(/host\[:port\]/);
  });
});

describe("previewSlugFromHost", () => {
  const config = { hostname: "vdxpreview.dev", port: null, scheme: "https" as const };

  it("extracts the one label below the preview host, ignoring port and case", () => {
    expect(previewSlugFromHost("k7f2qa.vdxpreview.dev", config)).toBe("k7f2qa");
    expect(previewSlugFromHost("K7F2QA.VDXPreview.dev:8444", config)).toBe("k7f2qa");
  });

  it("refuses the app host, the bare preview host, nested labels and odd slugs", () => {
    expect(previewSlugFromHost("app.example.com", config)).toBeNull();
    expect(previewSlugFromHost("vdxpreview.dev", config)).toBeNull();
    expect(previewSlugFromHost("a.b.vdxpreview.dev", config)).toBeNull();
    expect(previewSlugFromHost("evilvdxpreview.dev", config)).toBeNull();
    expect(previewSlugFromHost("ab.vdxpreview.dev", config)).toBeNull();
    expect(previewSlugFromHost("has_underscore.vdxpreview.dev", config)).toBeNull();
    expect(previewSlugFromHost(undefined, config)).toBeNull();
  });

  it("builds the origin the slug is served at", () => {
    expect(previewOrigin("k7f2qa", config)).toBe("https://k7f2qa.vdxpreview.dev");
    expect(previewOrigin("k7f2qa", { hostname: "preview.localhost", port: 5173, scheme: "http" })).toBe("http://k7f2qa.preview.localhost:5173");
  });
});
