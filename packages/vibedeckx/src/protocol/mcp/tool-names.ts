/**
 * How the two CLIs spell an MCP tool call.
 *
 * Claude Code reports `mcp__<server>__<tool>`; Codex reports the bare tool name
 * with the server in a field of its own. The frontend matches tools by name to
 * pick a card (cross-remote calls get one that names the target machine), so
 * providers qualify onto Claude's shape and the UI only has to know one.
 */
export function qualifiedMcpToolName(tool: string, server?: string): string {
  const serverName = server?.trim();
  // No server to attribute it to, or already qualified (our own tools arrive
  // canonicalized): leave it exactly as reported.
  if (!serverName || tool.startsWith("mcp__")) return tool;
  return `mcp__${serverName}__${tool}`;
}
