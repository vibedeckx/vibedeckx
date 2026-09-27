import { describe, it, expect, vi } from "vitest";
import {
  auditRetentionDays,
  DEFAULT_AUDIT_RETENTION_DAYS,
  pruneCrossRemoteAudit,
} from "./cross-remote-retention.js";
import { MS_PER_DAY } from "./session-retention-config.js";

describe("auditRetentionDays", () => {
  it("uses a valid configured window", () => {
    expect(auditRetentionDays("30")).toBe(30);
  });

  // The audit is a security record: a bad or empty value must not turn
  // pruning off, only fall back to the default.
  it.each([undefined, "", "0", "-5", "abc", "12.5"])("falls back to the default for %j", (raw) => {
    expect(auditRetentionDays(raw)).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });
});

describe("pruneCrossRemoteAudit", () => {
  const now = Date.parse("2026-09-27T00:00:00Z");

  it("drains the backlog batch by batch and stops on the first short batch", async () => {
    const batches = [2, 2, 1];
    const pruneBefore = vi.fn(async () => batches.shift() ?? 0);
    const storage = { crossRemoteAudit: { pruneBefore } } as unknown as Parameters<typeof pruneCrossRemoteAudit>[0];

    expect(await pruneCrossRemoteAudit(storage, { now, auditDays: 10, batchSize: 2 })).toBe(5);
    expect(pruneBefore).toHaveBeenCalledTimes(3);
    expect(pruneBefore).toHaveBeenCalledWith(new Date(now - 10 * MS_PER_DAY), 2);
  });
});
