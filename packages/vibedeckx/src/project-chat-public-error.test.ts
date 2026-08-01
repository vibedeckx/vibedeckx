import { describe, expect, it } from "vitest";

import { redactProjectChatSensitiveText } from "./project-chat-public-error.js";

describe("Project Chat public error redaction", () => {
  it("redacts quoted and punctuated Unix paths plus Windows absolute paths", () => {
    const source = [
      "ENOENT: open '/home/alice/.config/key'",
      "config=(/opt/vibedeckx/private.json)",
      'Windows file "C:\\Users\\Alice\\.config\\key.json"',
      "UNC \\\\server\\private\\credential.txt",
    ].join("; ");

    const redacted = redactProjectChatSensitiveText(source);

    expect(redacted).not.toContain("/home/alice");
    expect(redacted).not.toContain("/opt/vibedeckx");
    expect(redacted).not.toContain("C:\\Users\\Alice");
    expect(redacted).not.toContain("\\\\server\\private");
    expect(redacted.match(/\[redacted path\]/g)?.length).toBe(4);
  });

  it("redacts vendor-prefixed secret environment assignments by suffix", () => {
    const source = [
      "OPENAI_API_KEY=sk-openai-private",
      "GITHUB_TOKEN='github-private'",
      'AWS_SECRET_ACCESS_KEY="aws-private"',
      "ACME_PRIVATE_KEY=private-key-material",
      "SERVICE_PASSWORD: password-value",
    ].join(" ");
    const redacted = redactProjectChatSensitiveText(source);

    for (const secret of [
      "sk-openai-private", "github-private", "aws-private", "private-key-material", "password-value",
    ]) expect(redacted).not.toContain(secret);
    expect(redacted.match(/\[redacted\]/g)?.length).toBe(5);
  });

  it("preserves ordinary safe guidance and non-assignment environment names", () => {
    const safe = "OPENAI_API_KEY is missing. Use /api/projects to retry; authentication token refresh is available.";
    expect(redactProjectChatSensitiveText(safe)).toBe(safe);
  });
});
