import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { maybeOpenBrowser } from "./open-browser.js";

const local = { url: "http://127.0.0.1:5173", tls: false, hasUi: true, authEnabled: false };

function fakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

describe("maybeOpenBrowser", () => {
  it("opens the UI for a local interactive start", async () => {
    const openUrl = vi.fn(async () => fakeChild());
    await maybeOpenBrowser(local, openUrl);
    expect(openUrl).toHaveBeenCalledWith(local.url);
  });

  it.each([
    ["TLS", { tls: true }],
    ["API-only mode", { hasUi: false }],
    ["--auth (hosted, e.g. HTTP behind nginx)", { authEnabled: true }],
  ])("does not open under %s", async (_name, override) => {
    const openUrl = vi.fn(async () => fakeChild());
    await maybeOpenBrowser({ ...local, ...override }, openUrl);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("survives a missing xdg-open (spawn ENOENT emitted on the child)", async () => {
    const child = fakeChild();
    await maybeOpenBrowser(local, async () => child);
    // Without a listener this emit would throw, i.e. crash the server.
    expect(() => child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });

  it("survives open() rejecting", async () => {
    await expect(maybeOpenBrowser(local, async () => { throw new Error("no browser"); })).resolves.toBeUndefined();
  });
});
