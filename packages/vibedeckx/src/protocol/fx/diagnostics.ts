/** Authentication is identified from handshake context and explicit evidence,
 * never from -32600 alone (which also means an invalid ACP request).
 * Keep the original error, including model/access errors, for troubleshooting.
 */
export function formatFxRequestFailure(method: string, message: string): string {
  const handshake = method === "initialize" || method === "session/new";
  const needsLogin = /\bnot authenticated\b|\bnot logged in\b|\b(?:run|use)\s+[`'"]?fx login\b/i.test(message);
  if (!handshake || !needsLogin) return `fx request failed: ${message}`;
  return "fx is not logged in. On the worker machine, as the user running the worker, "
    + "run fx login vercel (Vercel AI Gateway), fx login codex (ChatGPT), or fx login grok for your configured source. "
    + "Then send another message to reconnect. ACP sessions cannot open an interactive login. "
    + "For diagnosis, run fx status --json or fx doctor --json."
    + `\n\nOriginal fx error:\n${message}`;
}
