# Branch Merge Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace sidebar badge showing whether the branch checked out in each worktree has been merged into its target branch, with a click-through to a "vs target" diff view.

**Architecture:** A pure computation module (`merge-status.ts`) does tiered git detection (tip equality → merge-base ancestor → `git cherry` patch-ids) plus a dirty check, cached by tip SHAs. A thin route file exposes it project- and path-based (remote proxying follows the `branch-activity-routes.ts` pattern). The diff routes gain a `compareTo` three-dot mode. The frontend adds a `useMergeStatus` hook (per-workspace target persisted in localStorage), a sidebar badge + row dropdown menu, and a "vs target" entry in the Diff tab's selector.

**Tech Stack:** Fastify, better git plumbing via `execFileSync`, vitest, Next.js/React 19, shadcn DropdownMenu/Select.

**Spec:** `docs/superpowers/specs/2026-07-12-branch-merge-status-design.md`

## Global Constraints

- Backend is ESM with NodeNext resolution — **all local imports need `.js` extensions** (`import { x } from "./merge-status.js"`).
- All git invocations that include user-supplied ref names MUST use `execFileSync("git", [args])` — never string-interpolated `execSync`.
- Backend typecheck: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json` (run from repo root).
- Frontend typecheck: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Backend tests: `cd packages/vibedeckx && npx vitest run <file>`. Frontend tests: `cd apps/vibedeckx-ui && npx vitest run <file>`.
- No new dependencies.
- Status values are exactly: `merged | partial | unmerged | no-unique-commits`.
- Deviations from spec (agreed during planning): (1) the status cache key includes the target branch, not just repo+branch — two workspaces may use different targets; (2) `no-unique-commits` = branch tip equals target tip (fresh branch), also returned if `git cherry` output is empty.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/vibedeckx/src/merge-status.ts` | Create | Tiered merge detection, default-branch detection, branch validation, tip-keyed cache |
| `packages/vibedeckx/src/merge-status.test.ts` | Create | Temp-git-repo tests for all detection tiers, dirty, cache, errors |
| `packages/vibedeckx/src/routes/merge-status-routes.ts` | Create | `/api/path/branches/merge-status` + `/api/projects/:id/branches/merge-status` (auth + remote proxy) |
| `packages/vibedeckx/src/server.ts` | Modify | Register the new route plugin |
| `packages/vibedeckx/src/routes/diff-routes.ts` | Modify | `compareTo` three-dot diff mode on both diff endpoints |
| `packages/vibedeckx/src/routes/diff-compare.test.ts` | Create | Test for the three-dot compare helper |
| `apps/vibedeckx-ui/lib/api.ts` | Modify | `MergeStatus*` types, `getMergeStatus()`, `compareTo` param on `getDiff()` |
| `apps/vibedeckx-ui/hooks/use-merge-status.ts` | Create | Per-target grouped fetching, localStorage target persistence |
| `apps/vibedeckx-ui/hooks/use-merge-status.test.ts` | Create | Tests for the pure grouping/key helpers |
| `apps/vibedeckx-ui/hooks/use-diff.ts` | Modify | Pass `compareTo` through |
| `apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx` | Create | Badge rendering (✓ / amber count / dirty dot) |
| `apps/vibedeckx-ui/components/layout/workspace-row-menu.tsx` | Create | `⋯` menu: Compare-against submenu + Delete worktree |
| `apps/vibedeckx-ui/components/layout/app-sidebar.tsx` | Modify | Mount badge + menu on workspace rows (replaces bare trash button) |
| `apps/vibedeckx-ui/components/diff/commit-selector.tsx` | Modify | "vs `<target>`" entry |
| `apps/vibedeckx-ui/components/diff/diff-panel.tsx` | Modify | Compare mode state, deep-link nonce |
| `apps/vibedeckx-ui/components/right-panel/right-panel.tsx` | Modify | `diffCompareNonce` → activate Diff tab |
| `apps/vibedeckx-ui/app/page.tsx` | Modify | Wire hook, sidebar props, badge-click → Diff tab |

---

### Task 1: Backend merge-status core module

**Files:**
- Create: `packages/vibedeckx/src/merge-status.ts`
- Test: `packages/vibedeckx/src/merge-status.test.ts`

**Interfaces:**
- Consumes: `parseGitWorktreeList`, `getWorktreeBaseForProject`, `invalidateWorktreeListCache` from `./utils/worktree-paths.js` (existing).
- Produces (used by Tasks 2–3):
  - `type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits"`
  - `interface MergeStatusEntry { branch: string; status: MergeStatusValue; unmergedCount: number; dirty: boolean }`
  - `interface MergeStatusResponse { target: string; entries: MergeStatusEntry[] }`
  - `computeMergeStatus(repoPath: string, target?: string): MergeStatusResponse` — throws `Error & { statusCode: 400 }` for missing/invalid target
  - `computeBranchMergeStatus(repoPath: string, branch: string, target: string): { status: MergeStatusValue; unmergedCount: number }`
  - `detectDefaultBranch(repoPath: string): string`
  - `validateBranchExists(repoPath: string, branch: string): boolean`
  - `clearMergeStatusCache(): void`

- [ ] **Step 1: Write the failing tests**

Create `packages/vibedeckx/src/merge-status.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  computeBranchMergeStatus,
  computeMergeStatus,
  detectDefaultBranch,
  validateBranchExists,
  clearMergeStatusCache,
} from "./merge-status.js";
import {
  getWorktreeBaseForProject,
  invalidateWorktreeListCache,
} from "./utils/worktree-paths.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
}

function initRepo(defaultBranch = "main"): string {
  const repo = mkdtempSync(path.join(tmpdir(), "merge-status-test-"));
  run(repo, ["init", "-b", defaultBranch]);
  run(repo, ["config", "user.email", "test@test.local"]);
  run(repo, ["config", "user.name", "Test"]);
  commit(repo, "base.txt", "base", "base commit");
  return repo;
}

describe("merge-status", () => {
  let repo: string;

  beforeEach(() => {
    clearMergeStatusCache();
    repo = initRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(getWorktreeBaseForProject(repo), { recursive: true, force: true });
  });

  describe("detectDefaultBranch", () => {
    it("prefers main", () => {
      expect(detectDefaultBranch(repo)).toBe("main");
    });

    it("falls back to master", () => {
      const masterRepo = initRepo("master");
      try {
        expect(detectDefaultBranch(masterRepo)).toBe("master");
      } finally {
        rmSync(masterRepo, { recursive: true, force: true });
      }
    });

    it("throws 400 when neither exists", () => {
      const bare = initRepo("trunk");
      try {
        expect(() => detectDefaultBranch(bare)).toThrowError(
          expect.objectContaining({ statusCode: 400 }),
        );
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe("validateBranchExists", () => {
    it("true for existing, false for missing", () => {
      expect(validateBranchExists(repo, "main")).toBe(true);
      expect(validateBranchExists(repo, "nope")).toBe(false);
    });
  });

  describe("computeBranchMergeStatus", () => {
    it("fresh branch at target tip => no-unique-commits", () => {
      run(repo, ["branch", "dev1"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "no-unique-commits",
        unmergedCount: 0,
      });
    });

    it("commits not in target => unmerged with count", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "unmerged",
        unmergedCount: 2,
      });
    });

    it("normal merge => merged (tier 1: ancestor)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      run(repo, ["checkout", "main"]);
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["merge", "dev1", "--no-edit"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "merged",
        unmergedCount: 0,
      });
    });

    it("cherry-picked (rebase-style) => merged (tier 2: patch-id)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      const devTip = run(repo, ["rev-parse", "dev1"]).trim();
      run(repo, ["checkout", "main"]);
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["cherry-pick", devTip]);
      // dev1 tip is NOT an ancestor of main, but its patch is in main.
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "merged",
        unmergedCount: 0,
      });
    });

    it("some commits cherry-picked => partial with count", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit 1");
      const first = run(repo, ["rev-parse", "dev1"]).trim();
      commit(repo, "b.txt", "b", "dev commit 2");
      run(repo, ["checkout", "main"]);
      run(repo, ["cherry-pick", first]);
      expect(computeBranchMergeStatus(repo, "dev1", "main")).toEqual({
        status: "partial",
        unmergedCount: 1,
      });
    });

    it("throws 400 for unknown branch", () => {
      expect(() => computeBranchMergeStatus(repo, "ghost", "main")).toThrowError(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("recomputes when the target tip moves (cache invalidation)", () => {
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "a.txt", "a", "dev commit");
      run(repo, ["checkout", "main"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main").status).toBe("unmerged");
      commit(repo, "m.txt", "m", "main advances");
      run(repo, ["merge", "dev1", "--no-edit"]);
      expect(computeBranchMergeStatus(repo, "dev1", "main").status).toBe("merged");
    });
  });

  describe("computeMergeStatus", () => {
    function addWorktree(branch: string): string {
      const base = getWorktreeBaseForProject(repo);
      mkdirSync(base, { recursive: true });
      const wtPath = path.join(base, branch);
      run(repo, ["worktree", "add", "-b", branch, wtPath]);
      invalidateWorktreeListCache(repo);
      return wtPath;
    }

    it("reports all worktree branches with dirty flags, omitting target", () => {
      const dev1 = addWorktree("dev1");
      commit(dev1, "a.txt", "a", "dev1 commit");
      const dev2 = addWorktree("dev2");
      writeFileSync(path.join(dev2, "uncommitted.txt"), "wip");

      const result = computeMergeStatus(repo);
      expect(result.target).toBe("main");
      const byBranch = new Map(result.entries.map((e) => [e.branch, e]));
      expect(byBranch.get("dev1")).toEqual({
        branch: "dev1",
        status: "unmerged",
        unmergedCount: 1,
        dirty: false,
      });
      expect(byBranch.get("dev2")).toEqual({
        branch: "dev2",
        status: "no-unique-commits",
        unmergedCount: 0,
        dirty: true,
      });
      expect(byBranch.has("main")).toBe(false);
    });

    it("omits detached-HEAD worktrees", () => {
      const base = getWorktreeBaseForProject(repo);
      mkdirSync(base, { recursive: true });
      run(repo, ["worktree", "add", "--detach", path.join(base, "detached")]);
      invalidateWorktreeListCache(repo);
      expect(computeMergeStatus(repo).entries).toEqual([]);
    });

    it("throws 400 for a nonexistent explicit target", () => {
      expect(() => computeMergeStatus(repo, "ghost")).toThrowError(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("accepts an explicit target", () => {
      addWorktree("dev1");
      run(repo, ["branch", "release"]);
      const result = computeMergeStatus(repo, "release");
      expect(result.target).toBe("release");
      // With an explicit non-main target, the main worktree's branch is no
      // longer the target, so it appears in the entries too.
      expect(result.entries.map((e) => e.branch).sort()).toEqual(["dev1", "main"]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vibedeckx && npx vitest run src/merge-status.test.ts`
Expected: FAIL — `Cannot find module './merge-status.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/vibedeckx/src/merge-status.ts`:

```ts
import { execFileSync } from "child_process";
import { parseGitWorktreeList } from "./utils/worktree-paths.js";

/**
 * Merged-ness detection for workspace branches vs a target branch.
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

export interface MergeStatusEntry {
  branch: string;
  status: MergeStatusValue;
  unmergedCount: number;
  dirty: boolean;
}

export interface MergeStatusResponse {
  target: string;
  entries: MergeStatusEntry[];
}

const MAX_BUFFER = 10 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function revParse(repoPath: string, ref: string): string | null {
  try {
    return git(repoPath, ["rev-parse", "--verify", ref]).trim();
  } catch {
    return null;
  }
}

export function validateBranchExists(repoPath: string, branch: string): boolean {
  return revParse(repoPath, `refs/heads/${branch}`) !== null;
}

export function detectDefaultBranch(repoPath: string): string {
  for (const candidate of ["main", "master"]) {
    if (validateBranchExists(repoPath, candidate)) return candidate;
  }
  throw Object.assign(new Error("No default branch (main/master) found"), { statusCode: 400 });
}

interface CachedStatus {
  branchTip: string;
  targetTip: string;
  status: MergeStatusValue;
  unmergedCount: number;
}

// Tip-keyed: an entry is valid as long as neither the branch tip nor the
// target tip has moved. `dirty` is intentionally NOT cached — working-tree
// changes don't move tips.
const statusCache = new Map<string, CachedStatus>();

export function clearMergeStatusCache(): void {
  statusCache.clear();
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tiered detection: tip equality → merge-base ancestor (normal/ff merges) →
 * `git cherry` patch-ids (rebase / cherry-pick merges). Squash merges are a
 * known phase-1 limitation: they show as unmerged (conservative).
 */
export function computeBranchMergeStatus(
  repoPath: string,
  branch: string,
  target: string,
): { status: MergeStatusValue; unmergedCount: number } {
  const branchTip = revParse(repoPath, `refs/heads/${branch}`);
  const targetTip = revParse(repoPath, `refs/heads/${target}`);
  if (!branchTip || !targetTip) {
    const missing = !branchTip ? branch : target;
    throw Object.assign(new Error(`Branch not found: ${missing}`), { statusCode: 400 });
  }

  const cacheKey = `${repoPath}\0${branch}\0${target}`;
  const cached = statusCache.get(cacheKey);
  if (cached && cached.branchTip === branchTip && cached.targetTip === targetTip) {
    return { status: cached.status, unmergedCount: cached.unmergedCount };
  }

  let status: MergeStatusValue;
  let unmergedCount = 0;

  if (branchTip === targetTip) {
    status = "no-unique-commits";
  } else if (isAncestor(repoPath, branchTip, targetTip)) {
    status = "merged";
  } else {
    const lines = git(repoPath, ["cherry", target, branch]).trim().split("\n").filter(Boolean);
    unmergedCount = lines.filter((l) => l.startsWith("+")).length;
    if (lines.length === 0) status = "no-unique-commits";
    else if (unmergedCount === 0) status = "merged";
    else if (unmergedCount < lines.length) status = "partial";
    else status = "unmerged";
  }

  statusCache.set(cacheKey, { branchTip, targetTip, status, unmergedCount });
  return { status, unmergedCount };
}

function isDirty(worktreePath: string): boolean {
  try {
    return git(worktreePath, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Merge status for every worktree branch of `repoPath` vs `target`
 * (auto-detected default branch when omitted). Worktree → branch mapping is
 * read live — users switch branches inside worktrees with git commands.
 */
export function computeMergeStatus(repoPath: string, target?: string): MergeStatusResponse {
  if (target && !validateBranchExists(repoPath, target)) {
    throw Object.assign(new Error(`Target branch not found: ${target}`), { statusCode: 400 });
  }
  const resolvedTarget = target ?? detectDefaultBranch(repoPath);

  const entries: MergeStatusEntry[] = [];
  for (const wt of parseGitWorktreeList(repoPath)) {
    if (!wt.branch || wt.branch === resolvedTarget) continue;
    const { status, unmergedCount } = computeBranchMergeStatus(repoPath, wt.branch, resolvedTarget);
    entries.push({ branch: wt.branch, status, unmergedCount, dirty: isDirty(wt.path) });
  }
  return { target: resolvedTarget, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vibedeckx && npx vitest run src/merge-status.test.ts`
Expected: PASS (14 tests)

Note: `parseGitWorktreeList` only trusts worktrees under `getWorktreeBaseForProject(repo)` — the test's `addWorktree` helper already creates them there. If the `computeMergeStatus` tests see empty entries, that trust filter is the first thing to check.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no output (clean)

```bash
git add packages/vibedeckx/src/merge-status.ts packages/vibedeckx/src/merge-status.test.ts
git commit -m "feat: tiered branch merge-status detection module"
```

---

### Task 2: Merge-status routes + registration

**Files:**
- Create: `packages/vibedeckx/src/routes/merge-status-routes.ts`
- Modify: `packages/vibedeckx/src/server.ts` (imports ~line 21, registration ~line 311)

**Interfaces:**
- Consumes: `computeMergeStatus` (Task 1), `proxyStatus`/`proxyToRemoteAuto` from `../utils/remote-proxy.js`, `requireAuth` from `../server.js`.
- Produces: `GET /api/path/branches/merge-status?path=&target=` and `GET /api/projects/:id/branches/merge-status?target=`, both returning `MergeStatusResponse` JSON (Task 4 consumes the project route).

- [ ] **Step 1: Write the route plugin**

Create `packages/vibedeckx/src/routes/merge-status-routes.ts`:

```ts
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { computeMergeStatus } from "../merge-status.js";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { requireAuth } from "../server.js";
import "../server-types.js";
import type { Project } from "../storage/types.js";

/**
 * Merge status API — is each worktree branch merged into its target branch?
 * See docs/superpowers/specs/2026-07-12-branch-merge-status-design.md.
 */

async function getRemoteConfig(fastify: FastifyInstance, project: Project) {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  if (remotes.length > 0) {
    const primary = remotes[0]; // sorted by sort_order
    return {
      serverId: primary.remote_server_id,
      url: primary.server_url ?? "",
      apiKey: primary.server_api_key ?? "",
      remotePath: primary.remote_path,
    };
  }
  if (project.remote_url && project.remote_api_key && project.remote_path) {
    return {
      serverId: "",
      url: project.remote_url,
      apiKey: project.remote_api_key,
      remotePath: project.remote_path,
    };
  }
  return null;
}

function sendComputed(reply: FastifyReply, repoPath: string, target?: string) {
  try {
    return reply.code(200).send(computeMergeStatus(repoPath, target));
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Failed to compute merge status";
    return reply.code(statusCode).send({ error: message });
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Path-based: used as the proxy target by remote backends.
  fastify.get<{ Querystring: { path?: string; target?: string } }>(
    "/api/path/branches/merge-status",
    async (req, reply) => {
      const projectPath = req.query.path;
      if (!projectPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      return sendComputed(reply, projectPath, req.query.target || undefined);
    },
  );

  // Project-based: local computation or proxy to remote for remote-only projects.
  fastify.get<{ Params: { id: string }; Querystring: { target?: string } }>(
    "/api/projects/:id/branches/merge-status",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (!project.path) {
        const remoteConfig = await getRemoteConfig(fastify, project);
        if (!remoteConfig) {
          return reply.code(400).send({ error: "Project has no local path" });
        }
        const params = new URLSearchParams({ path: remoteConfig.remotePath });
        if (req.query.target) params.set("target", req.query.target);
        const result = await proxyToRemoteAuto(
          remoteConfig.serverId,
          remoteConfig.url,
          remoteConfig.apiKey,
          "GET",
          `/api/path/branches/merge-status?${params.toString()}`,
          undefined,
          { reverseConnectManager: fastify.reverseConnectManager },
        );
        return reply.code(proxyStatus(result)).send(result.data);
      }

      return sendComputed(reply, project.path, req.query.target || undefined);
    },
  );
};

export default fp(routes, { name: "merge-status-routes" });
```

- [ ] **Step 2: Register in server.ts**

In `packages/vibedeckx/src/server.ts`, next to the existing route imports (~line 21):

```ts
import mergeStatusRoutes from "./routes/merge-status-routes.js";
```

Next to `server.register(branchActivityRoutes);` (~line 311):

```ts
server.register(mergeStatusRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: clean

- [ ] **Step 4: Manual verification against the dev server**

```bash
pnpm dev:server &   # or use an already-running dev backend on 5173
sleep 3
# Grab a project id first:
curl -s http://localhost:5173/api/projects | head -c 400
curl -s "http://localhost:5173/api/projects/<PROJECT_ID>/branches/merge-status" | head -c 600
curl -s "http://localhost:5173/api/projects/<PROJECT_ID>/branches/merge-status?target=ghost-branch"
```

Expected: first call returns `{"target":"main","entries":[...]}` with one entry per non-target worktree branch; second returns `{"error":"Target branch not found: ghost-branch"}` with HTTP 400. (If `VIBEDECKX_API_KEY` is set in your dev env, add `-H "x-api-key: $VIBEDECKX_API_KEY"`.)

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/merge-status-routes.ts packages/vibedeckx/src/server.ts
git commit -m "feat: merge-status API routes with remote proxying"
```

---

### Task 3: Diff routes `compareTo` mode

**Files:**
- Modify: `packages/vibedeckx/src/routes/diff-routes.ts`
- Test: `packages/vibedeckx/src/routes/diff-compare.test.ts` (create)

**Interfaces:**
- Consumes: `validateBranchExists` (Task 1).
- Produces: `compareTo` querystring param on `GET /api/path/diff` and `GET /api/projects/:id/diff` (Task 4's `getDiff` consumes it); named export `runCompareToDiff(cwd: string, compareTo: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/routes/diff-compare.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { runCompareToDiff } from "./diff-routes.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(repo, file), content);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
}

describe("runCompareToDiff", () => {
  it("returns only the branch's changes since the merge-base (three-dot)", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "diff-compare-test-"));
    try {
      run(repo, ["init", "-b", "main"]);
      run(repo, ["config", "user.email", "test@test.local"]);
      run(repo, ["config", "user.name", "Test"]);
      commit(repo, "base.txt", "base", "base");
      run(repo, ["checkout", "-b", "dev1"]);
      commit(repo, "feature.txt", "branch-change", "dev commit");
      run(repo, ["checkout", "main"]);
      commit(repo, "mainline.txt", "main-only-change", "main advances");
      run(repo, ["checkout", "dev1"]);

      const diff = runCompareToDiff(repo, "main");
      expect(diff).toContain("+branch-change");
      // Three-dot must NOT show main's own advance as a deletion.
      expect(diff).not.toContain("main-only-change");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/routes/diff-compare.test.ts`
Expected: FAIL — `runCompareToDiff` is not exported

- [ ] **Step 3: Implement in diff-routes.ts**

Add to the imports at the top of `packages/vibedeckx/src/routes/diff-routes.ts`:

```ts
import { execFileSync } from "child_process";
import { validateBranchExists } from "../merge-status.js";
```

Add below `buildDiffFallbackCommand` (~line 72):

```ts
/** Three-dot diff: everything `HEAD` would bring to `compareTo` since their merge-base. */
export function runCompareToDiff(cwd: string, compareTo: string): string {
  return execFileSync("git", ["diff", `${compareTo}...HEAD`, "--no-color"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
}
```

In the **path-based** route (`/api/path/diff`), change the Querystring type to
`{ path: string; branch?: string; commit?: string; compareTo?: string }` and insert after the commit-hash validation (~line 153):

```ts
    const compareTo = req.query.compareTo;
    if (commit && compareTo) {
      return reply.code(400).send({ error: "commit and compareTo are mutually exclusive" });
    }
    if (compareTo) {
      const cwd = resolveWorktreePath(projectPath, branch ?? null);
      if (!validateBranchExists(cwd, compareTo)) {
        return reply.code(400).send({ error: `Branch not found: ${compareTo}` });
      }
      try {
        // Committed content only — no untracked-file injection in compare mode.
        return reply.code(200).send({ files: parseDiffOutput(runCompareToDiff(cwd, compareTo)) });
      } catch {
        return reply.code(200).send({ files: [] });
      }
    }
```

In the **project-based** route (`/api/projects/:id/diff`), change the Querystring type to
`{ branch?: string; commit?: string; compareTo?: string; target?: 'local' | 'remote' }`, read
`const compareTo = req.query.compareTo;` next to `commit` (~line 222), add the same mutual-exclusion 400 right after the commit-hash validation, forward it in the remote-proxy params (~line 239):

```ts
      if (compareTo) params.push(`compareTo=${encodeURIComponent(compareTo)}`);
```

and insert the same local `if (compareTo) { ... }` block (using `project.path` for `resolveWorktreePath`) right after the `if (!project.path)` guard (~line 254), before the existing cwd/untracked logic.

- [ ] **Step 4: Run test to verify it passes, then typecheck**

Run: `cd packages/vibedeckx && npx vitest run src/routes/diff-compare.test.ts`
Expected: PASS

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/diff-routes.ts packages/vibedeckx/src/routes/diff-compare.test.ts
git commit -m "feat: compareTo three-dot mode on diff routes"
```

---

### Task 4: Frontend API + useMergeStatus hook

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts` (types near line 285, methods near `getProjectWorktrees` ~line 981, `getDiff` ~line 1215)
- Modify: `apps/vibedeckx-ui/hooks/use-diff.ts`
- Create: `apps/vibedeckx-ui/hooks/use-merge-status.ts`
- Test: `apps/vibedeckx-ui/hooks/use-merge-status.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's project route, Task 3's `compareTo` param.
- Produces (used by Tasks 5–6):
  - api.ts: `MergeStatusValue`, `MergeStatusEntry`, `MergeStatusResponse` types; `api.getMergeStatus(id: string, target?: string): Promise<MergeStatusResponse | null>`; `api.getDiff(projectId, branch?, commit?, target?, compareTo?)`.
  - hook: `useMergeStatus(projectId: string | null, worktrees: Worktree[])` returning `{ statuses: Map<string, BranchMergeInfo>, defaultTarget: string | null, setTarget(branch: string, target: string | null): void, refetch(): void }` where `BranchMergeInfo = MergeStatusEntry & { target: string }`.
  - `useDiff(projectId, branch?, commit?, target?, compareTo?)`.

- [ ] **Step 1: Write the failing test for the pure helpers**

Create `apps/vibedeckx-ui/hooks/use-merge-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupBranchesByTarget, mergeTargetStorageKey } from "./use-merge-status";

describe("mergeTargetStorageKey", () => {
  it("is scoped by project and branch", () => {
    expect(mergeTargetStorageKey("p1", "dev3")).toBe("vibedeckx:mergeTarget:p1:dev3");
  });
});

describe("groupBranchesByTarget", () => {
  it("groups branches by their persisted target, null for default", () => {
    const targets: Record<string, string | null> = { dev3: null, dev4: "dev1", dev5: "dev1" };
    const groups = groupBranchesByTarget(["dev3", "dev4", "dev5"], (b) => targets[b]);
    expect(groups.get(null)).toEqual(["dev3"]);
    expect(groups.get("dev1")).toEqual(["dev4", "dev5"]);
  });

  it("returns an empty map for no branches", () => {
    expect(groupBranchesByTarget([], () => null).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run hooks/use-merge-status.test.ts`
Expected: FAIL — cannot resolve `./use-merge-status`

- [ ] **Step 3: Add API types and methods**

In `apps/vibedeckx-ui/lib/api.ts`, after the `Worktree` interface (~line 285):

```ts
export type MergeStatusValue = "merged" | "partial" | "unmerged" | "no-unique-commits";

export interface MergeStatusEntry {
  branch: string;
  status: MergeStatusValue;
  unmergedCount: number;
  dirty: boolean;
}

export interface MergeStatusResponse {
  target: string;
  entries: MergeStatusEntry[];
}
```

After `getProjectWorktrees` (~line 991):

```ts
  async getMergeStatus(id: string, target?: string): Promise<MergeStatusResponse | null> {
    try {
      const params = new URLSearchParams();
      if (target) params.set("target", target);
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await authFetch(`${getApiBase()}/api/projects/${id}/branches/merge-status${query}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },
```

Change `getDiff` (~line 1215) signature and body:

```ts
  async getDiff(projectId: string, branch?: string | null, commit?: string | null, target?: 'local' | 'remote', compareTo?: string | null): Promise<DiffResponse> {
```

and add alongside the other params:

```ts
    if (compareTo) {
      params.set('compareTo', compareTo);
    }
```

- [ ] **Step 4: Thread compareTo through use-diff.ts**

In `apps/vibedeckx-ui/hooks/use-diff.ts`, change the signature to

```ts
export function useDiff(projectId: string | null, branch?: string | null, commit?: string | null, target?: 'local' | 'remote', compareTo?: string | null) {
```

change the call to `api.getDiff(projectId, branch, commit, target, compareTo)`, and add `compareTo` to the `useCallback` dependency array: `[projectId, branch, commit, target, compareTo]`.

- [ ] **Step 5: Write the hook**

Create `apps/vibedeckx-ui/hooks/use-merge-status.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type MergeStatusEntry, type Worktree } from "@/lib/api";

export interface BranchMergeInfo extends MergeStatusEntry {
  target: string;
}

export function mergeTargetStorageKey(projectId: string, branch: string): string {
  return `vibedeckx:mergeTarget:${projectId}:${branch}`;
}

function readMergeTarget(projectId: string, branch: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(mergeTargetStorageKey(projectId, branch));
}

/** Group workspace branches by persisted target; null key = backend default. Pure — exported for tests. */
export function groupBranchesByTarget(
  branches: string[],
  readTarget: (branch: string) => string | null,
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const branch of branches) {
    const target = readTarget(branch);
    const list = groups.get(target) ?? [];
    list.push(branch);
    groups.set(target, list);
  }
  return groups;
}

/**
 * Merge status per workspace branch, fetched once per distinct target.
 * Refreshes whenever the worktree list identity changes (same cadence as
 * useWorktrees) or after setTarget.
 */
export function useMergeStatus(projectId: string | null, worktrees: Worktree[]) {
  const [statuses, setStatuses] = useState<Map<string, BranchMergeInfo>>(new Map());
  const [defaultTarget, setDefaultTarget] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // Depends on the worktrees array identity: useWorktrees replaces it on every
  // fetch, so merge status refreshes on the same cadence (spec requirement).
  useEffect(() => {
    const branches = worktrees
      .map((w) => w.branch)
      .filter((b): b is string => b !== null);
    if (!projectId || branches.length === 0) {
      setStatuses(new Map());
      setDefaultTarget(null);
      return;
    }
    let cancelled = false;

    (async () => {
      const groups = groupBranchesByTarget(branches, (b) => readMergeTarget(projectId, b));
      const next = new Map<string, BranchMergeInfo>();
      let nextDefault: string | null = null;

      await Promise.all(
        Array.from(groups.entries()).map(async ([target, groupBranches]) => {
          const resp = await api.getMergeStatus(projectId, target ?? undefined);
          if (!resp) {
            // Explicit target failed (e.g. branch deleted since it was chosen) —
            // drop the stale persisted choice; the next refresh uses the default.
            if (target) {
              for (const b of groupBranches) {
                localStorage.removeItem(mergeTargetStorageKey(projectId, b));
              }
            }
            return;
          }
          if (!target) nextDefault = resp.target;
          for (const entry of resp.entries) {
            // The backend reports every worktree branch for the requested
            // target; keep only the branches that chose this target.
            if (groupBranches.includes(entry.branch)) {
              next.set(entry.branch, { ...entry, target: resp.target });
            }
          }
        }),
      );

      if (!cancelled) {
        setStatuses(next);
        setDefaultTarget(nextDefault);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, worktrees, nonce]);

  const setTarget = useCallback(
    (branch: string, target: string | null) => {
      if (!projectId) return;
      if (target) {
        localStorage.setItem(mergeTargetStorageKey(projectId, branch), target);
      } else {
        localStorage.removeItem(mergeTargetStorageKey(projectId, branch));
      }
      refetch();
    },
    [projectId, refetch],
  );

  return { statuses, defaultTarget, setTarget, refetch };
}
```

- [ ] **Step 6: Run tests, typecheck**

Run: `cd apps/vibedeckx-ui && npx vitest run hooks/use-merge-status.test.ts`
Expected: PASS (3 tests)

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-diff.ts apps/vibedeckx-ui/hooks/use-merge-status.ts apps/vibedeckx-ui/hooks/use-merge-status.test.ts
git commit -m "feat(ui): merge-status API client and useMergeStatus hook"
```

---

### Task 5: Sidebar badge + workspace row menu

**Files:**
- Create: `apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx`
- Create: `apps/vibedeckx-ui/components/layout/workspace-row-menu.tsx`
- Modify: `apps/vibedeckx-ui/components/layout/app-sidebar.tsx` (props ~line 13-34, workspace rows ~line 355-397)
- Modify: `apps/vibedeckx-ui/app/page.tsx` (hook ~line 135, AppSidebar props ~line 539)

**Interfaces:**
- Consumes: `useMergeStatus`/`BranchMergeInfo` (Task 4), `api.getProjectBranches` (existing), shadcn `dropdown-menu` (existing), `onDeleteWorktree` flow in page.tsx (existing).
- Produces: new AppSidebar props consumed in this task's page.tsx edit:
  `mergeStatuses?: Map<string, BranchMergeInfo>`, `mergeDefaultTarget?: string | null`, `onMergeTargetChange?: (branch: string, target: string) => void`, `onMergeBadgeClick?: (branch: string) => void`. Task 6 wires `onMergeBadgeClick`'s Diff-tab side; this task can log/no-op the tab part but MUST select the branch.

- [ ] **Step 1: Create the badge component**

Create `apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx`:

```tsx
"use client";

import { Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

interface WorkspaceMergeBadgeProps {
  info: BranchMergeInfo;
  onClick: () => void;
}

export function WorkspaceMergeBadge({ info, onClick }: WorkspaceMergeBadgeProps) {
  // A fresh branch with a clean worktree needs no badge at all.
  if (info.status === "no-unique-commits" && !info.dirty) return null;

  const label =
    info.status === "merged"
      ? `Merged into ${info.target}`
      : info.status === "no-unique-commits"
        ? `No commits vs ${info.target}`
        : `${info.unmergedCount} commit${info.unmergedCount !== 1 ? "s" : ""} not in ${info.target}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="relative shrink-0 flex items-center justify-center h-4 min-w-4 px-0.5 rounded hover:bg-muted"
        >
          {info.status === "merged" ? (
            <Check className="h-3 w-3 text-muted-foreground/70" />
          ) : info.status !== "no-unique-commits" ? (
            <span className="text-[10px] font-mono leading-none text-amber-500">
              {info.unmergedCount}
            </span>
          ) : null}
          {info.dirty && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-orange-400" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {info.dirty ? " · uncommitted changes" : ""}
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 2: Create the row menu component**

Create `apps/vibedeckx-ui/components/layout/workspace-row-menu.tsx`:

```tsx
"use client";

import { useState } from "react";
import { GitMerge, MoreHorizontal, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface WorkspaceRowMenuProps {
  projectId: string;
  branch: string;
  /** Effective compare target shown as checked (persisted choice or default). */
  currentTarget: string | null;
  onTargetChange: (target: string) => void;
  onDelete: () => void;
}

export function WorkspaceRowMenu({
  projectId,
  branch,
  currentTarget,
  onTargetChange,
  onDelete,
}: WorkspaceRowMenuProps) {
  const [branches, setBranches] = useState<string[] | null>(null);

  const loadBranches = async () => {
    if (branches !== null) return;
    const list = await api.getProjectBranches(projectId);
    setBranches(list.filter((b) => b !== branch));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-muted transition-all"
          title="Workspace menu"
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger onPointerEnter={loadBranches} onFocus={loadBranches}>
            <GitMerge className="h-3.5 w-3.5 mr-1.5" />
            Compare against
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {branches === null ? (
              <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
            ) : branches.length === 0 ? (
              <DropdownMenuItem disabled>No other branches</DropdownMenuItem>
            ) : (
              branches.map((b) => (
                <DropdownMenuCheckboxItem
                  key={b}
                  checked={b === currentTarget}
                  onCheckedChange={() => onTargetChange(b)}
                >
                  <span className="font-mono text-xs">{b}</span>
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete worktree
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Mount both in app-sidebar.tsx**

In `apps/vibedeckx-ui/components/layout/app-sidebar.tsx`:

Add imports:

```tsx
import { WorkspaceMergeBadge } from "./workspace-merge-badge";
import { WorkspaceRowMenu } from "./workspace-row-menu";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";
```

(`Trash2` remains used by the menu component only — remove it from this file's lucide import.)

Add to `AppSidebarProps` (after `onDeleteWorktree` ~line 21):

```tsx
  mergeStatuses?: Map<string, BranchMergeInfo>;
  mergeDefaultTarget?: string | null;
  onMergeTargetChange?: (branch: string, target: string) => void;
  onMergeBadgeClick?: (branch: string) => void;
```

and destructure them in the component signature next to `onDeleteWorktree` (~line 196).

Replace the workspace row block (~lines 365-397: the `div.group` containing the branch button and the absolute trash button) with:

```tsx
                      <div className="group relative flex items-center min-w-0 gap-0.5 pr-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => {
                                onBranchChange?.(wt.branch);
                                onViewChange("workspace");
                              }}
                              className={cn(
                                "flex-1 min-w-0 flex items-center gap-2 rounded-[3px] pl-2 pr-1 py-1 font-mono text-[11.5px] transition-colors overflow-hidden",
                                !isActive && "text-foreground/80 hover:bg-muted",
                                isActive && "text-accent-foreground font-medium"
                              )}
                            >
                              <StatusDot status={dotStatus} />
                              <span className="truncate text-left">{wt.branch ?? "main"}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">{wt.branch ?? "main"}</TooltipContent>
                        </Tooltip>
                        {wt.branch !== null && mergeStatuses?.get(wt.branch) && (
                          <WorkspaceMergeBadge
                            info={mergeStatuses.get(wt.branch)!}
                            onClick={() => onMergeBadgeClick?.(wt.branch!)}
                          />
                        )}
                        {wt.branch !== null && currentProject && (
                          <WorkspaceRowMenu
                            projectId={currentProject.id}
                            branch={wt.branch}
                            currentTarget={
                              mergeStatuses?.get(wt.branch)?.target ?? mergeDefaultTarget ?? null
                            }
                            onTargetChange={(t) => onMergeTargetChange?.(wt.branch!, t)}
                            onDelete={() => onDeleteWorktree?.(wt)}
                          />
                        )}
                      </div>
```

(The changes vs the original: `pr-6` → `pr-1` on the branch button, `gap-0.5 pr-1` on the container, absolute trash button replaced by inline badge + menu.)

- [ ] **Step 4: Wire in page.tsx**

In `apps/vibedeckx-ui/app/page.tsx`:

```tsx
import { useMergeStatus } from '@/hooks/use-merge-status';
```

After the `useWorktrees` line (~line 135):

```tsx
  const {
    statuses: mergeStatuses,
    defaultTarget: mergeDefaultTarget,
    setTarget: setMergeTarget,
  } = useMergeStatus(currentProject?.id ?? null, worktrees);
```

Add to the `<AppSidebar` props (~line 547, next to `onDeleteWorktree`):

```tsx
            mergeStatuses={mergeStatuses}
            mergeDefaultTarget={mergeDefaultTarget}
            onMergeTargetChange={setMergeTarget}
            onMergeBadgeClick={(branch) => {
              setSelectedBranch(branch);
              setActiveView("workspace");
            }}
```

(Task 6 extends `onMergeBadgeClick` to also open the Diff tab.)

- [ ] **Step 5: Typecheck, lint, visual check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: clean

Run: `pnpm --filter vibedeckx-ui lint`
Expected: no new errors

Run `pnpm dev:all`, open http://localhost:3000, pick a project with worktrees:
- each workspace row with unmerged commits shows an amber count; merged branches show a gray check; dirty worktrees have an orange dot overlay
- hover a row → `⋯` appears; menu shows "Compare against" submenu (other branches listed, current target checked) and red "Delete worktree"
- picking a different target updates that row's badge only
- delete still opens the existing confirm dialog

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/layout/workspace-merge-badge.tsx apps/vibedeckx-ui/components/layout/workspace-row-menu.tsx apps/vibedeckx-ui/components/layout/app-sidebar.tsx apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): workspace merge-status badge and row menu"
```

---

### Task 6: Diff tab "vs target" mode + badge deep-link

**Files:**
- Modify: `apps/vibedeckx-ui/components/diff/commit-selector.tsx`
- Modify: `apps/vibedeckx-ui/components/diff/diff-panel.tsx`
- Modify: `apps/vibedeckx-ui/components/right-panel/right-panel.tsx` (props ~line 15-26, effect after `usePersistedTab` ~line 60, DiffPanel props ~line 143)
- Modify: `apps/vibedeckx-ui/app/page.tsx` (nonce state ~line 103, badge click ~Task 5's block, RightPanel props ~line 632)

**Interfaces:**
- Consumes: `useDiff(..., compareTo)` (Task 4), `mergeStatuses`/`mergeDefaultTarget` from page.tsx (Task 5).
- Produces: `CommitSelector` new optional props `compareTarget?: string | null; compareSelected?: boolean; onSelectCompare?: () => void`; `DiffPanel` new optional props `mergeTarget?: string | null; compareRequestNonce?: number`; `RightPanel` new optional props `diffCompareNonce?: number; mergeTarget?: string | null`.

- [ ] **Step 1: Extend CommitSelector**

In `apps/vibedeckx-ui/components/diff/commit-selector.tsx`, add a sentinel and props:

```tsx
const COMPARE_SENTINEL = '__compare__';
```

```tsx
interface CommitSelectorProps {
  commits: CommitEntry[];
  selectedCommit: string | null;
  onSelectCommit: (commit: string | null) => void;
  compareTarget?: string | null;
  compareSelected?: boolean;
  onSelectCompare?: () => void;
  loading?: boolean;
  disabled?: boolean;
}
```

Change the `Select` value/handler and add the item:

```tsx
    <Select
      value={compareSelected ? COMPARE_SENTINEL : (selectedCommit ?? HEAD_SENTINEL)}
      onValueChange={(value) => {
        if (value === COMPARE_SENTINEL) {
          onSelectCompare?.();
        } else {
          onSelectCommit(value === HEAD_SENTINEL ? null : value);
        }
      }}
      disabled={disabled || loading}
    >
```

and in `SelectContent`, right after the HEAD item:

```tsx
        {compareTarget && (
          <SelectItem value={COMPARE_SENTINEL}>
            vs <span className="font-mono text-xs">{compareTarget}</span>
          </SelectItem>
        )}
```

(Destructure `compareTarget, compareSelected, onSelectCompare` in the component parameters.)

- [ ] **Step 2: Add compare mode to DiffPanel**

In `apps/vibedeckx-ui/components/diff/diff-panel.tsx`:

Extend props:

```tsx
interface DiffPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  onMergeRequest?: () => void;
  project?: Project | null;
  mergeTarget?: string | null;
  compareRequestNonce?: number;
}
```

(destructure the two new props). Add state + effects near `selectedCommit` (~line 23):

```tsx
  const [compareMode, setCompareMode] = useState(false);
  const prevCompareNonceRef = useRef(compareRequestNonce);

  // Badge deep-link: a nonce bump means "show the vs-target comparison now".
  useEffect(() => {
    if (compareRequestNonce === undefined) return;
    if (prevCompareNonceRef.current === compareRequestNonce) return;
    prevCompareNonceRef.current = compareRequestNonce;
    setCompareMode(true);
    setSinceCommit(null);
  }, [compareRequestNonce]);
```

(add `useRef` to the react import). Extend the existing branch-change reset (~line 54):

```tsx
  // Reset selection when branch changes
  useEffect(() => {
    setSinceCommit(null);
    setCompareMode(false);
  }, [selectedBranch]);
```

Change the `useDiff` call (~line 42):

```tsx
  const compareTo = compareMode && mergeTarget ? mergeTarget : null;
  const { diff, loading, error, refresh } = useDiff(projectId, selectedBranch, selectedCommit, hookTarget, compareTo);
```

Change the `CommitSelector` usage (~line 112):

```tsx
          <CommitSelector
            commits={commits}
            selectedCommit={selectedCommit}
            onSelectCommit={(commit) => {
              setCompareMode(false);
              setSinceCommit(commit);
            }}
            compareTarget={mergeTarget}
            compareSelected={compareMode}
            onSelectCompare={() => {
              setCompareMode(true);
              setSinceCommit(null);
            }}
            loading={commitsLoading}
            disabled={loading}
          />
```

Change the empty-state message (~line 142):

```tsx
              <p>
                {compareMode && mergeTarget
                  ? `No changes vs ${mergeTarget}`
                  : selectedCommit
                    ? 'No changes in this commit'
                    : 'No uncommitted changes'}
              </p>
```

- [ ] **Step 3: Thread through RightPanel**

In `apps/vibedeckx-ui/components/right-panel/right-panel.tsx`, add to `RightPanelProps`:

```tsx
  diffCompareNonce?: number;
  mergeTarget?: string | null;
```

(destructure both). After the `activateAgentTabNonce` effect (~line 68) — order matters: this must run after `usePersistedTab`'s key-reset effect so the Diff tab wins when branch and nonce change together:

```tsx
  const prevDiffCompareNonceRef = useRef(diffCompareNonce);
  useEffect(() => {
    if (diffCompareNonce === undefined) return;
    if (prevDiffCompareNonceRef.current === diffCompareNonce) return;
    prevDiffCompareNonceRef.current = diffCompareNonce;
    setActiveTab('diff');
  }, [diffCompareNonce, setActiveTab]);
```

Pass both to `DiffPanel` (~line 143):

```tsx
          <DiffPanel
            projectId={projectId}
            selectedBranch={selectedBranch}
            onMergeRequest={onMergeRequest}
            project={project}
            mergeTarget={mergeTarget}
            compareRequestNonce={diffCompareNonce}
          />
```

- [ ] **Step 4: Complete the page.tsx wiring**

In `apps/vibedeckx-ui/app/page.tsx`, next to `activateAgentTabNonce` (~line 103):

```tsx
  const [diffCompareNonce, setDiffCompareNonce] = useState(0);
```

Extend the Task 5 badge handler:

```tsx
            onMergeBadgeClick={(branch) => {
              setSelectedBranch(branch);
              setActiveView("workspace");
              setDiffCompareNonce((n) => n + 1);
            }}
```

Add to the `<RightPanel` props (~line 636):

```tsx
                    diffCompareNonce={diffCompareNonce}
                    mergeTarget={
                      selectedBranch
                        ? (mergeStatuses.get(selectedBranch)?.target ?? mergeDefaultTarget)
                        : null
                    }
```

- [ ] **Step 5: Typecheck, lint, end-to-end check**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit` — expected clean.
Run: `pnpm --filter vibedeckx-ui lint` — expected no new errors.

With `pnpm dev:all` running:
1. Click an amber badge on a workspace with unmerged commits → view switches to that workspace, Diff tab opens, selector shows "vs main", diff shows exactly the branch's unmerged changes (no untracked files listed).
2. Click a gray-check badge → Diff tab opens showing "No changes vs main".
3. In the Diff tab selector, switch back to "HEAD (uncommitted)" → normal uncommitted diff returns; switch to a commit → per-commit diff works as before.
4. Change a workspace's target via the row menu, click its badge → diff compares against the new target.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/diff/commit-selector.tsx apps/vibedeckx-ui/components/diff/diff-panel.tsx apps/vibedeckx-ui/components/right-panel/right-panel.tsx apps/vibedeckx-ui/app/page.tsx
git commit -m "feat(ui): vs-target diff mode with badge deep-link"
```

---

### Task 7: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test suites**

```bash
cd packages/vibedeckx && npx vitest run
cd ../../apps/vibedeckx-ui && npx vitest run
```

Expected: all pass (including pre-existing suites — the diff-routes and sidebar edits must not break `right-panel.test.tsx` / `use-worktrees.test.ts`).

- [ ] **Step 2: Both typechecks + lint**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit
pnpm --filter vibedeckx-ui lint
```

Expected: all clean.

- [ ] **Step 3: Real-repo scenario walkthrough**

With `pnpm dev:all` and a real project:

```bash
# In the project repo, stage the scenarios:
git worktree list                       # note existing workspaces
# scenario A: a branch already merged to main  → expect gray ✓
# scenario B: a branch with unmerged commits   → expect amber count
# scenario C: touch a file in a worktree       → expect dirty dot overlay
```

Verify in the UI: badges match the git reality above; badge click opens the correct vs-target diff; menu target switch re-renders the badge; delete-worktree flow unchanged.

- [ ] **Step 4: Verify no regression on remote projects**

If a remote-configured project is available: its sidebar badges load via the proxy (`/api/path/branches/merge-status` on the remote). If the remote backend is older (endpoint missing), badges simply don't render — the sidebar must not error.

- [ ] **Step 5: Final commit (if any fixups)**

```bash
git status   # commit any fixups from the sweep with a descriptive message
```
