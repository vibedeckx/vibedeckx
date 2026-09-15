import { describe, it, expect } from "vitest";
import { remoteServerIdOf } from "./remote-session-id";

describe("remoteServerIdOf", () => {
  const server = "5a967959-f5b4-4f9f-bab7-22f1997e69ef";
  const project = "82192b68-707f-4882-bafe-b24c1bb97f0f";
  const session = "296cb6af-478c-4922-a24a-a370567b2043";

  it("reads the machine out of a remote session id", () => {
    expect(remoteServerIdOf(`remote-${server}-${project}-${session}`)).toBe(server);
  });

  it("has no machine for a local session or a missing one", () => {
    expect(remoteServerIdOf(session)).toBeNull();
    expect(remoteServerIdOf(null)).toBeNull();
    expect(remoteServerIdOf("")).toBeNull();
  });

  it("does not mistake other `remote-` ids for a session", () => {
    // Process ids are `remote-{executorId}-{processId}`, review runs
    // `remote-{server}-{project}-{runId}` — only a uuid in the first slot is
    // a machine, and anything else must not be read as one.
    expect(remoteServerIdOf("remote-schedule-task1-proc2")).toBeNull();
    expect(remoteServerIdOf("remote-claude-p1-s1")).toBeNull();
  });
});
