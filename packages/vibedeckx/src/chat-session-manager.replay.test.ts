import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";
import type { Storage } from "./storage/types.js";

/**
 * Main Chat replay on subscribe is built from terminal entries, not a patch
 * log: one add-op per message at its current content, all in a single frame.
 * A streamed answer that was rewritten N times must NOT replay as N frames.
 */
describe("ChatSessionManager.subscribe replay", () => {
  function makeManager() {
    return new ChatSessionManager(
      {} as Storage,
      {} as ProcessManager,
      { getSessionByBranch: vi.fn(() => null), emitBranchActivityIfChanged: vi.fn() } as unknown as AgentSessionManager,
      new Map(),
      new Map(),
      {} as RemotePatchCache,
    );
  }

  function frames(send: ReturnType<typeof vi.fn>): unknown[] {
    return send.mock.calls.map(([raw]) => JSON.parse(raw as string));
  }

  it("sends status + Ready only for an empty session", () => {
    const manager = makeManager();
    const id = manager.getOrCreateSession("p1", "dev", "u1");
    const send = vi.fn();
    const unsubscribe = manager.subscribe(id, { send } as unknown as WebSocket);
    expect(unsubscribe).not.toBeNull();
    expect(frames(send)).toEqual([
      { JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "stopped" } }] },
      { Ready: true },
    ]);
  });

  it("replays each entry once, at its terminal content, in one frame", () => {
    const manager = makeManager();
    const id = manager.getOrCreateSession("p1", "dev", "u1");
    const session = manager.getSession(id)!;
    const push = (manager as unknown as { pushEntry: (s: typeof session, e: unknown) => void }).pushEntry.bind(manager);

    push(session, { type: "user", content: "hi", timestamp: 1 });
    push(session, { type: "assistant", content: "H", partial: true, timestamp: 2 });
    // Streaming rewrites the same index many times; only the last shape survives.
    for (const content of ["He", "Hel", "Hell", "Hello"]) {
      session.store.entries[1] = { type: "assistant", content, partial: true, timestamp: 2 };
    }
    session.store.entries[1] = { type: "assistant", content: "Hello", partial: false, timestamp: 2 };
    push(session, { type: "turn_end", timestamp: 3 });

    const send = vi.fn();
    manager.subscribe(id, { send } as unknown as WebSocket);
    const out = frames(send);

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      JsonPatch: [
        { op: "add", path: "/entries/0", value: { type: "ENTRY", content: { type: "user", content: "hi", timestamp: 1 } } },
        { op: "add", path: "/entries/1", value: { type: "ENTRY", content: { type: "assistant", content: "Hello", partial: false, timestamp: 2 } } },
        { op: "add", path: "/entries/2", value: { type: "ENTRY", content: { type: "turn_end", timestamp: 3 } } },
      ],
    });
    expect(out[1]).toEqual({ JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "stopped" } }] });
    expect(out[2]).toEqual({ Ready: true });
  });

  it("replays nothing after reset", () => {
    const manager = makeManager();
    const id = manager.getOrCreateSession("p1", "dev", "u1");
    const session = manager.getSession(id)!;
    (manager as unknown as { pushEntry: (s: typeof session, e: unknown) => void })
      .pushEntry(session, { type: "user", content: "hi", timestamp: 1 });
    expect(manager.resetSession(id)).toBe(true);

    const send = vi.fn();
    manager.subscribe(id, { send } as unknown as WebSocket);
    expect(frames(send).filter((f) => "JsonPatch" in (f as object) && (f as { JsonPatch: { path: string }[] }).JsonPatch.some((p) => p.path.startsWith("/entries")))).toHaveLength(0);
  });
});
