import { describe, expect, it } from "vitest";
import { buildStartupFailureMessage } from "./agent-session-manager.js";

describe("buildStartupFailureMessage", () => {
  const CLAUDE_MODEL_ERROR =
    "There's an issue with the selected model (bogus). It may not exist or you may not have access to it.";

  it("includes an unparseable stdout tail in the details", () => {
    const msg = buildStartupFailureMessage("claude-code", "", CLAUDE_MODEL_ERROR);
    expect(msg).toContain(CLAUDE_MODEL_ERROR);
  });

  it("omits the install hint when the CLI explained itself", () => {
    // The CLI is clearly installed — it ran and printed a diagnosis. Telling
    // the user it "doesn't seem to be installed" is actively misleading.
    const msg = buildStartupFailureMessage("claude-code", "", CLAUDE_MODEL_ERROR);
    expect(msg).not.toContain("doesn't seem to be installed");
  });

  it("keeps the install hint when the process said nothing at all", () => {
    const msg = buildStartupFailureMessage("claude-code", "", "");
    expect(msg).toContain("Couldn't start");
    expect(msg).toContain("doesn't seem to be installed");
  });

  it("keeps the install hint when only stderr spoke — npx failed to fetch the CLI", () => {
    // Regression: suppressing the hint on ANY output dropped it in the case it
    // was written for. With no native binary the spawn falls back to npx; with
    // no network npm writes `npm ERR! …` to STDERR and exits non-zero, which is
    // the primary "not installed" path after ENOENT. The user needs the hint
    // (which names the npx-needs-network caveat) alongside the npm noise.
    const msg = buildStartupFailureMessage("claude-code", "npm ERR! network", "");
    expect(msg).toContain("doesn't seem to be installed");
    expect(msg).toContain("npm ERR! network");
  });

  it("includes both streams when both produced output", () => {
    const msg = buildStartupFailureMessage("claude-code", "stderr line", "stdout line");
    expect(msg).toContain("stderr line");
    expect(msg).toContain("stdout line");
  });
});
