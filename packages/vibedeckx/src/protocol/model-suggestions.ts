/**
 * Suggested model names per agent CLI.
 *
 * These are SUGGESTIONS, not a whitelist — the picker also accepts free text
 * and nothing validates against this list. Whether a name works depends on the
 * installed CLI version, the machine's account tier, and the provider's
 * server-side availability; none of that is knowable here, so a bad name is
 * allowed through and fails with the CLI's own error message.
 *
 * Claude entries are deliberately ALIASES, not dated model ids: an alias always
 * points at the current model in its tier, so this list cannot rot. A dated id
 * like "claude-opus-4-5-20251101" would be stale within months.
 */
export const MODEL_SUGGESTIONS: Record<"claude-code" | "codex", readonly string[]> = {
  "claude-code": ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
} as const;
