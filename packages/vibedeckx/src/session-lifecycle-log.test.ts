import { describe, expect, it, vi } from "vitest";
import {
  formatSessionLifecycleLog,
  isSessionPurpose,
  logSessionLifecycle,
  SESSION_LIFECYCLE_LOG_PREFIX,
} from "./session-lifecycle-log.js";

describe("session lifecycle log format", () => {
  it("emits one grep-able key=value line with the event first", () => {
    const line = formatSessionLifecycleLog({
      event: "created", sessionId: "s1", projectId: "p1", branch: "dev",
      purpose: "commander", operationId: "call-1", recovered: false,
    });
    expect(line).toBe(
      `${SESSION_LIFECYCLE_LOG_PREFIX} event=created sessionId=s1 projectId=p1 branch=dev purpose=commander operationId=call-1 recovered=false`,
    );
  });

  it("omits undefined fields, prints null, and quotes values containing whitespace or '='", () => {
    const line = formatSessionLifecycleLog({
      event: "created", sessionId: "s1", projectId: "p1", branch: null,
      purpose: "interactive", operationId: undefined, recovered: true,
    });
    expect(line).not.toContain("operationId");
    expect(line).toContain("branch=null");

    const quoted = formatSessionLifecycleLog({
      event: "discard_remote", localSessionId: "remote-a b=c", remoteServerId: "srv", outcome: "http_500",
    });
    expect(quoted).toContain('localSessionId="remote-a b=c"');
  });

  it("writes through the given sink", () => {
    const sink = vi.fn();
    logSessionLifecycle({ event: "boot_zero_entry_rows", count: 3 }, sink);
    expect(sink).toHaveBeenCalledWith(`${SESSION_LIFECYCLE_LOG_PREFIX} event=boot_zero_entry_rows count=3`);
  });

  it("only accepts the closed purpose set", () => {
    expect(isSessionPurpose("workflow_review")).toBe(true);
    expect(isSessionPurpose("visible")).toBe(false);
    expect(isSessionPurpose(undefined)).toBe(false);
  });
});
