# Agent Model Suggestions Update Design

## Goal

Update the model suggestions shown by the Claude Code and Codex model pickers.

The final suggestion lists are:

- Claude Code: `opus`, `sonnet`, `haiku`, `fable`
- Codex: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`

This removes `gpt-5.6-codex` and `o3` from the Codex suggestions.

## Architecture

Keep the existing server-owned suggestion flow:

1. `MODEL_SUGGESTIONS` defines the lists in the backend protocol layer.
2. `GET /api/agent-providers` returns the relevant list for each provider.
3. The frontend fetches that endpoint and passes the returned models to the
   existing model picker.

The frontend will not gain a second hard-coded copy of the lists. Suggestions
remain suggestions rather than a whitelist, so users may still enter a model
name that is not listed.

## Changes

Update only the shared backend suggestion constant and its route-level
regression test. The test will assert the complete ordered list for both
providers so additions and removals are covered explicitly.

No UI component, API contract, session persistence, or CLI argument behavior
changes are required.

## Verification

Run the focused provider-route test, followed by the backend typecheck. The
focused test must first fail against the old lists and then pass after updating
the shared constant.
