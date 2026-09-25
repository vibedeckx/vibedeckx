import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  appendRemoteGrantContext,
  buildRemoteGrantContext,
  stripRemoteGrantContext,
} from "./cross-remote-grant-context.js";
import { extractUserText } from "./utils/conversation-title.js";

/** docs/cross-remote-session-grants-design.md §6. */
describe("cross-remote grant context", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-grantctx-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const server = async (name: string, tier: "read" | "exec" | "off") => {
    const row = await storage.remoteServers.create({ name }, "user-1");
    if (tier !== "off") await storage.remoteServers.update(row.id, { cross_remote_access: tier }, "user-1");
    return row.id;
  };

  it("produces no block for a session with no grants", async () => {
    expect(await buildRemoteGrantContext(storage, "s1", "user-1")).toBeNull();
    expect(await appendRemoteGrantContext(storage, "s1", "user-1", "hello")).toBe("hello");
  });

  it("names each granted machine with its id and tier", async () => {
    const a = await server("ubuntu-1", "exec");
    const b = await server("mac-mini", "read");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a, b]);

    const block = await buildRemoteGrantContext(storage, "s1", "user-1");
    // The open tag carries the display list for the UI chip; the prose inside
    // is what the agent reads. Both are ordered by name, not by the random
    // server id the storage tiebreak would otherwise pick.
    expect(block).toContain('<vremotes names="mac-mini, ubuntu-1">');
    expect(block).toContain(`mac-mini (id: ${b}, read), ubuntu-1 (id: ${a}, exec)`);
    // Being granted is not an instruction to run everything there.
    expect(block).toContain("the local workspace remains the default target");
    // Nor an invitation to fix code on the machine where the bug was found.
    expect(block).toContain("Make code changes (editing files, git operations, installing dependencies) in the local workspace");
    expect(block).toContain("only modify a remote machine when the user explicitly asks");
  });

  it("leaves out a machine whose tier was turned off after the grant", async () => {
    const a = await server("ubuntu-1", "exec");
    const b = await server("mac-mini", "read");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a, b]);
    await storage.remoteServers.update(b, { cross_remote_access: "off" }, "user-1");

    const block = await buildRemoteGrantContext(storage, "s1", "user-1");
    expect(block).toContain("ubuntu-1");
    expect(block).not.toContain("mac-mini");
  });

  it("produces no block when every granted machine has been turned off", async () => {
    const a = await server("ubuntu-1", "exec");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    await storage.remoteServers.update(a, { cross_remote_access: "off" }, "user-1");

    expect(await buildRemoteGrantContext(storage, "s1", "user-1")).toBeNull();
  });

  it("appends to a string after what the user typed, and as a part to ContentPart[]", async () => {
    const a = await server("ubuntu-1", "exec");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);

    const asString = await appendRemoteGrantContext(storage, "s1", "user-1", "check the logs");
    expect(typeof asString).toBe("string");
    expect(asString as string).toMatch(/^check the logs\n\n<vremotes names="ubuntu-1">/);

    const asParts = await appendRemoteGrantContext(storage, "s1", "user-1", [
      { type: "text", text: "check the logs" },
      { type: "image", mediaType: "image/png", data: "x" },
    ]);
    expect(Array.isArray(asParts)).toBe(true);
    const parts = asParts as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(3);
    expect(parts[2].text).toContain("<vremotes names=");
  });

  it("is stripped out of the text titles and review briefs read", async () => {
    const a = await server("ubuntu-1", "exec");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    const delivered = await appendRemoteGrantContext(storage, "s1", "user-1", "fix the build");

    expect(extractUserText(delivered)).toBe("fix the build");
    expect(stripRemoteGrantContext("a\n<vremotes>\nx\n</vremotes>")).toBe("a");
  });
});
