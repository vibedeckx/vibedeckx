# Codex Cross-Remote MCP Injection Design

## Problem

Cross-remote MCP configuration reaches `AgentProvider.buildSpawnConfig`, but
`CodexProvider` discards it. Codex sessions therefore start without the
session-scoped cross-remote MCP server.

## Design

Pass the optional `CrossRemoteMcpConfig` into the Codex app-server CLI builder.
When present, append a Codex config override for
`mcp_servers.cross-remote` containing the streamable HTTP URL and a
`bearer_token_env_var` reference. Put the actual session token in the spawned
process environment so it does not appear in command-line arguments.

Keep the existing no-config invocation unchanged for both native Codex and the
`npx` fallback. Claude's `--mcp-config` JSON remains provider-specific and is
not reused for Codex.

## Error Handling

No new runtime fallback is introduced. Codex reports MCP startup failures over
its existing app-server protocol. Existing minting gates remain authoritative:
the public URL, authenticated user, and accessible target remote must all be
present before configuration is injected.

## Testing

- Verify native and `npx` app-server commands include the Codex MCP override.
- Verify the bearer token is present only in the child environment, not CLI
  arguments.
- Verify calls without cross-remote configuration preserve the current command.
- Verify `CodexProvider` forwards the configuration into the CLI builder.

