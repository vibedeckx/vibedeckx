import { describe, it, expect } from "vitest";
import {
  signCrossRemoteToken,
  verifyCrossRemoteToken,
  CROSS_REMOTE_TOKEN_TTL_MS,
  type CrossRemoteTokenPayload,
} from "./cross-remote-token.js";

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = 1_700_000_000_000;

const payload: CrossRemoteTokenPayload = {
  userId: "user-1",
  sessionId: "remote-abc",
  sourceRemoteServerId: "srv-a",
};

describe("cross-remote token", () => {
  it("round-trips a payload", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW)).toEqual(payload);
  });

  it("preserves a null sourceRemoteServerId", () => {
    const token = signCrossRemoteToken(SECRET, { ...payload, sourceRemoteServerId: null }, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW)?.sourceRemoteServerId).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken("other-secret", token, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    const [body, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
    decoded.u = "user-2";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;
    expect(verifyCrossRemoteToken(SECRET, forged, NOW)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW + CROSS_REMOTE_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("accepts a token one millisecond before expiry", () => {
    const token = signCrossRemoteToken(SECRET, payload, NOW);
    expect(verifyCrossRemoteToken(SECRET, token, NOW + CROSS_REMOTE_TOKEN_TTL_MS - 1)).toEqual(payload);
  });

  it("rejects structurally invalid tokens", () => {
    expect(verifyCrossRemoteToken(SECRET, "", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "no-dot", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "a.b.c", NOW)).toBeNull();
    expect(verifyCrossRemoteToken(SECRET, "!!!.###", NOW)).toBeNull();
  });

  it("rejects a token with an empty userId or sessionId", () => {
    // An empty userId would make remoteServers.getById(id, "") fall through to the
    // unscoped query, resolving any tenant's remote. Fail closed at verification.
    const noUser = signCrossRemoteToken(SECRET, { ...payload, userId: "" }, NOW);
    expect(verifyCrossRemoteToken(SECRET, noUser, NOW)).toBeNull();

    const noSession = signCrossRemoteToken(SECRET, { ...payload, sessionId: "" }, NOW);
    expect(verifyCrossRemoteToken(SECRET, noSession, NOW)).toBeNull();
  });
});
