# Security Notes

This document tracks security considerations for future hardening if the application is exposed beyond local development use.

## Path Traversal in Executor Start Endpoint

**Location:** `packages/vibedeckx/src/server.ts` - `/api/executors/:id/start` endpoint

**Current Behavior:** The `worktreePath` parameter is resolved relative to the project path without validation that the result stays within the project directory.

**Risk Level:** Low for current use case (local development tool with trusted users).

**Why Acceptable Now:**
- This is a local development tool running on the user's machine
- The user controls both the projects and git worktrees
- worktreePath values come from `git worktree list` output, not arbitrary user input
- The user already has full filesystem access

**Future Hardening (if exposing to untrusted input):**

```typescript
// Add after resolving worktreePath:
if (worktreePath && worktreePath !== ".") {
  const resolvedPath = path.resolve(project.path, worktreePath);
  // Security: Ensure resolved path is within project directory or parent
  const projectParent = path.dirname(project.path);
  if (!resolvedPath.startsWith(projectParent + path.sep)) {
    return reply.code(400).send({ error: "Invalid worktree path" });
  }
  basePath = resolvedPath;
}
```

Note: We check `projectParent` rather than `project.path` because git worktrees are typically created in sibling directories (e.g., `../.worktrees/feature-x`).

## Browser Preview Runs Proxied Pages as App-Origin Script

**Location:** `packages/vibedeckx/src/routes/browser-proxy-routes.ts`, preview iframe sandbox in `apps/vibedeckx-ui/components/preview/browser-frames-provider.tsx`.

**Current Behavior:** Previewed dev-server URLs are served through a same-origin proxy into an iframe sandboxed with `allow-scripts allow-same-origin`, so proxied content executes with the Vibedeckx origin.

**Risk Level:** Low for current use case (solo, self-hosted, no-auth; users preview only their own trusted dev servers). `allow-same-origin` is required for preview functionality (storage/cookies/HMR/login state).

**Future Hardening (before hosted multi-tenant `--auth`):** Serve the proxy from a separate origin so `allow-same-origin` can stay without exposing the main app origin/token. Full design and implementation checklist: [browser-preview-origin-isolation.md](browser-preview-origin-isolation.md).

## Browser Preview Proxy SSRF (Server-Side Egress)

**Location:** `packages/vibedeckx/src/routes/browser-proxy-routes.ts` (direct-fetch branch of the HTTP/WS proxy), guard in `packages/vibedeckx/src/utils/ssrf-guard.ts`.

**Issue:** The proxy's direct branch makes the control-plane server connect to the target URL and returns the body (full-read SSRF) — reaching cloud metadata (`169.254.169.254`), internal services, and loopback. Distinct from, and not addressed by, the origin-isolation fix above (that is browser-side; this is server-side egress).

**Status:** **Fixed** for hosted (`--auth`) mode — outbound requests on the direct branch are filtered (scheme allowlist + private/loopback/link-local/metadata IP block + DNS-rebinding pinning + per-redirect re-validation). Off in solo so `localhost`/LAN preview keeps working. Reverse-connect previews are unaffected (they tunnel to the user's own machine). Design + impact: [browser-preview-ssrf.md](browser-preview-ssrf.md).
