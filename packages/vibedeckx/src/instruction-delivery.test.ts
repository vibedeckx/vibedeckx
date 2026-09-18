import { describe, expect, it, vi } from "vitest";
import { deliverInstruction, instructionContentHash, serializeSessionMutation } from "./instruction-delivery.js";

type Row = { hash: string; status: "pending" | "sent"; token: string | null };

function makeLedger(overrides: Partial<Record<"renewClaim" | "markSent", () => Promise<boolean>>> = {}) {
  const rows = new Map<string, Row>();
  const k = (o: { sessionId: string; idempotencyKey: string }) => `${o.sessionId}:${o.idempotencyKey}`;
  const ledger = {
    claim: vi.fn(async (o: { sessionId: string; idempotencyKey: string; contentHash: string; claimToken: string }) => {
      const row = rows.get(k(o));
      if (!row) { rows.set(k(o), { hash: o.contentHash, status: "pending", token: o.claimToken }); return "claimed" as const; }
      if (row.hash !== o.contentHash) return "conflict" as const;
      if (row.status === "sent") return "sent" as const;
      if (row.token !== null) return "busy" as const;
      row.token = o.claimToken;
      return "claimed" as const;
    }),
    renewClaim: vi.fn(overrides.renewClaim ?? (async () => true)),
    markSent: vi.fn(overrides.markSent ?? (async () => true)),
    release: vi.fn(async (o: { sessionId: string; idempotencyKey: string }) => {
      const row = rows.get(k(o));
      if (row) row.token = null;
    }),
  };
  // markSent default must flip the row so a replay sees `sent`.
  if (!overrides.markSent) {
    ledger.markSent.mockImplementation(async (...args: unknown[]) => {
      const o = args[0] as { sessionId: string; idempotencyKey: string };
      const row = rows.get(k(o));
      if (!row) return false;
      row.status = "sent";
      return true;
    });
  }
  return { rows, ledger, storage: { agentInstructionDeliveries: ledger } as never };
}

const base = { sessionId: "s1", idempotencyKey: "k1", rawContent: "hello" };

describe("deliverInstruction", () => {
  it("delivers once, then replays the same key + content without sending again", async () => {
    const { storage } = makeLedger();
    const deliver = vi.fn(async () => true);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("delivered");
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("replayed");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reports a conflict when the key is reused with different content", async () => {
    const { storage } = makeLedger();
    const deliver = vi.fn(async () => true);
    await deliverInstruction({ ...base, storage, deliver });
    expect(await deliverInstruction({ ...base, rawContent: "other", storage, deliver })).toBe("conflict");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reports busy while another claim is live, without sending", async () => {
    const { storage, rows } = makeLedger();
    rows.set("s1:k1", { hash: instructionContentHash("hello"), status: "pending", token: "someone-else" });
    const deliver = vi.fn(async () => true);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("busy");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("releases the claim when the runtime refuses, so a retry re-sends", async () => {
    const { storage, ledger } = makeLedger();
    const deliver = vi.fn(async () => false);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("not_running");
    expect(ledger.release).toHaveBeenCalledTimes(1);
    deliver.mockResolvedValue(true);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("does not send when ownership is lost before the send", async () => {
    const { storage } = makeLedger({ renewClaim: async () => false });
    const deliver = vi.fn(async () => true);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("ownership_lost_before_send");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("distinguishes ownership lost after the send", async () => {
    let calls = 0;
    const { storage, ledger } = makeLedger({ renewClaim: async () => ++calls === 1 });
    const deliver = vi.fn(async () => true);
    expect(await deliverInstruction({ ...base, storage, deliver })).toBe("ownership_lost_after_send");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(ledger.markSent).not.toHaveBeenCalled();
  });

  it("reports unconfirmed when the sent mark cannot be written", async () => {
    const { storage } = makeLedger({ markSent: async () => false });
    expect(await deliverInstruction({ ...base, storage, deliver: async () => true })).toBe("unconfirmed");
  });

  it("releases the claim and rethrows when the send throws", async () => {
    const { storage, ledger } = makeLedger();
    await expect(deliverInstruction({ ...base, storage, deliver: async () => { throw new Error("boom"); } }))
      .rejects.toThrow("boom");
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent deliveries of one key: exactly one send", async () => {
    const { storage } = makeLedger();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deliver = vi.fn(async () => { await gate; return true; });
    const a = deliverInstruction({ ...base, storage, deliver });
    const b = deliverInstruction({ ...base, storage, deliver });
    release();
    expect((await Promise.all([a, b])).sort()).toEqual(["delivered", "replayed"]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("serializeSessionMutation", () => {
  it("runs effects for one session strictly in order and isolates sessions", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = serializeSessionMutation("sess", async () => {
      await new Promise<void>((r) => { releaseFirst = r; });
      order.push("first");
    });
    const second = serializeSessionMutation("sess", async () => { order.push("second"); });
    const other = serializeSessionMutation("other", async () => { order.push("other"); });
    await other;
    expect(order).toEqual(["other"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["other", "first", "second"]);
  });

  it("releases the lock when the effect throws", async () => {
    await expect(serializeSessionMutation("sess2", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await serializeSessionMutation("sess2", async () => "ok")).toBe("ok");
  });
});
