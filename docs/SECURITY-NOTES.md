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

## Preview Links (formerly the same-origin browser preview)

**Location:** `packages/vibedeckx/src/preview/`, `routes/preview-link-routes.ts`.

**History:** The Browser tab used to proxy dev servers same-origin into an `allow-scripts allow-same-origin` iframe (app-origin script execution), fetch arbitrary URLs from the control plane (full-read SSRF, mitigated by `ssrf-guard.ts`), and feed page-controlled events to the Main Chat as prompts. All three surfaces were removed.

**Current design:** Each preview is `<slug>.<preview-host>`, a per-link origin foreign to the app and to every other preview, opened top-level in a new tab. The hub forwards only to a machine linked to the project over the reverse-connect tunnel (or `127.0.0.1:<port>` in solo mode); there is no direct fetch of caller-supplied hosts. Auth is a one-time ticket exchanged for a signed `HttpOnly` cookie scoped to that one host; the cookie authorizes one slug's proxy and nothing else. Under `--auth` with no preview host the feature is off (fail closed). Preview hosts are dispatched before Fastify, so no app route, hook or Clerk credential is evaluated on them. The preview domain must not be a subdomain of the app domain (Clerk parent-domain cookies). Design: [preview-links-design.md](preview-links-design.md).

**Residual:** a user previewing a hostile dev server exposes only that preview's origin. Bodies are buffered in memory (16 MB cap).

