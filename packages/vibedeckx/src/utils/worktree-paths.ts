import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import type { Storage, RegisteredWorkspaceCheckout } from "../storage/types.js";

const WORKTREE_BASE_DIR = "/var/tmp/vibedeckx/worktrees";
const WORKTREE_LIST_TTL_MS = 10_000;

interface CachedWorktreeList {
  entries: Array<{ path: string; branch: string | null }>;
  expiresAt: number;
}

export interface WorktreeBranch {
  /** Stable workspace identity used by sessions and the UI. */
  branch: string | null;
  /** Present only when this worktree is no longer checked out on `branch`. */
  currentBranch?: string | null;
}

const worktreeListCache = new Map<string, CachedWorktreeList>();

/** Stable short identifier for a project path */
function getProjectIdentifier(projectPath: string): string {
  const basename = path.basename(projectPath);
  const hash = createHash("md5").update(projectPath).digest("hex").slice(0, 8);
  return `${basename}-${hash}`;
}

function isSubpath(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A worktree path is trusted only if it is the project root itself or lives
 *  under this project's own managed worktree base. Git can report stale,
 *  prunable, or otherwise attacker-influenced `.git/worktrees/*` metadata that
 *  points anywhere on disk (e.g. `/etc`); such paths must never be returned to
 *  callers that use them as a filesystem confinement root. */
function isTrustedWorktreePath(projectPath: string, worktreePath: string): boolean {
  const normalizedWorktreePath = path.resolve(worktreePath);
  if (normalizedWorktreePath === path.resolve(projectPath)) return true;
  const managedBase = path.resolve(getWorktreeBaseForProject(projectPath));
  return isSubpath(managedBase, normalizedWorktreePath);
}

function readWorktreeListFromGit(projectPath: string): Array<{ path: string; branch: string | null }> {
  const output = execSync("git worktree list --porcelain", {
    cwd: projectPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const entries: Array<{ path: string; branch: string | null }> = [];
  const blocks = output.trim().split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n");
    let worktreePath = "";
    let branch: string | null = null;
    let isPrunable = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      else if (line === "prunable" || line.startsWith("prunable ")) isPrunable = true;
    }

    // Skip prunable (stale) records and any path outside this project's trusted
    // worktree base — those can carry attacker-controlled `gitdir` targets.
    if (worktreePath && !isPrunable && isTrustedWorktreePath(projectPath, worktreePath)) {
      entries.push({ path: worktreePath, branch });
    }
  }

  return entries;
}

/** Parse `git worktree list --porcelain`, cached per projectPath for ~10s. */
export function parseGitWorktreeList(projectPath: string): Array<{ path: string; branch: string | null }> {
  const now = Date.now();
  const cached = worktreeListCache.get(projectPath);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }
  const entries = readWorktreeListFromGit(projectPath);
  worktreeListCache.set(projectPath, { entries, expiresAt: now + WORKTREE_LIST_TTL_MS });
  return entries;
}

/**
 * The workspaces a project has when Git cannot answer — a project directory
 * that is not a repository still has exactly one workspace: its own root.
 * Returning that (instead of throwing) is what lets a non-git project own a
 * registered checkout and therefore bind its sessions.
 */
function readWorktreeListTolerant(projectPath: string): Array<{ path: string; branch: string | null }> {
  try {
    return parseGitWorktreeList(projectPath);
  } catch {
    return [{ path: projectPath, branch: null }];
  }
}

/** Run `git worktree prune` and invalidate the cached list for this project.
 *  Call from list-style API handlers; not on every internal lookup.
 *  Best-effort: a non-git project has nothing to prune and must not fail the
 *  caller that was only refreshing its workspace list. */
export function pruneWorktrees(projectPath: string): void {
  try {
    execSync("git worktree prune", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Not a repository, or git unavailable — nothing to prune.
  } finally {
    worktreeListCache.delete(projectPath);
  }
}

/** Invalidate the cached list for a project — call after add/remove succeeds. */
export function invalidateWorktreeListCache(projectPath: string): void {
  worktreeListCache.delete(projectPath);
}

/** Resolve branch to absolute filesystem path. null = main worktree. */
export function resolveWorktreePath(projectPath: string, branch: string | null): string {
  if (!branch) return projectPath;
  // Prefer git's real worktree path for the branch. parseGitWorktreeList only
  // returns trusted, non-prunable paths (project root or under the managed
  // base), so a match here is always safely confined.
  try {
    const entries = parseGitWorktreeList(projectPath);
    const match = entries.find((e) => e.branch === branch);
    if (match) return match.path;
  } catch {
    // git failed (not a repo, etc.) — fall through to convention.
  }
  const dirName = branch.replace(/\//g, "-");
  const base = path.join(WORKTREE_BASE_DIR, getProjectIdentifier(projectPath));
  const candidate = path.join(base, dirName);
  // Containment guard: a branch that doesn't map to a real git worktree must
  // resolve to a path inside this project's own worktree base. Otherwise a
  // value like ".." escapes via path.join to the shared worktree root (or
  // beyond), letting a caller reach sibling projects' worktrees.
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw Object.assign(new Error("Invalid branch"), { statusCode: 400 });
  }
  return candidate;
}

/** Get the base worktree directory for a project (for mkdir) */
export function getWorktreeBaseForProject(projectPath: string): string {
  return path.join(WORKTREE_BASE_DIR, getProjectIdentifier(projectPath));
}

export function conventionalWorktreePath(projectPath: string, branch: string): string {
  return path.join(getWorktreeBaseForProject(projectPath), branch.replace(/\//g, "-"));
}

export interface WorkspaceIdentityAnchor {
  branch: string;
  worktreePath: string;
  expectedBranch: string;
}

/**
 * Preserve the branch a workspace's sessions were created under even if an
 * agent switched that physical worktree to another branch. Session rows are a
 * durable identity anchor; the live Git branch is runtime state only.
 */
export function reconcileWorktreeBranches(
  projectPath: string,
  entries: Array<{ path: string; branch: string | null }>,
  sessionBranches: Iterable<string> = [],
  registry: Iterable<WorkspaceIdentityAnchor> = [],
): WorktreeBranch[] {
  const registryByPath = new Map<string, WorkspaceIdentityAnchor>();
  for (const anchor of registry) registryByPath.set(path.resolve(anchor.worktreePath), anchor);
  const stableBranchByPath = new Map<string, string>();
  for (const branch of sessionBranches) {
    if (!branch) continue; // "" is the main-workspace sentinel.
    stableBranchByPath.set(path.resolve(conventionalWorktreePath(projectPath, branch)), branch);
  }

  const rootEntry = entries[0];
  const rootAnchor = rootEntry ? registryByPath.get(path.resolve(rootEntry.path)) : undefined;
  // Drift is only claimable when Git actually names a branch. A root with no
  // branch (detached HEAD, or a project directory that is not a repository)
  // has nothing to compare against — reporting it as drifted would be a
  // permanent false positive for non-git projects. An empty expected branch is
  // the same "unknown" placeholder recorded on the other side: the root was
  // registered before the directory became a repository, so a branch appearing
  // later (git init → main) is adoption, not drift.
  const rootDrifted = Boolean(rootAnchor)
    && rootAnchor!.expectedBranch !== ""
    && rootEntry?.branch != null
    && rootEntry.branch !== rootAnchor!.expectedBranch;
  const worktrees: WorktreeBranch[] = [rootDrifted
    ? { branch: null, currentBranch: rootEntry?.branch ?? null }
    : { branch: null }];
  // The first entry is the project/main worktree. Its stable API identity is
  // deliberately null and is not derived from whichever branch it has checked
  // out, matching the existing workspace model.
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const anchor = registryByPath.get(path.resolve(entry.path));
    const stableBranch = anchor?.branch || stableBranchByPath.get(path.resolve(entry.path));
    if (stableBranch) {
      const expectedBranch = anchor?.expectedBranch ?? stableBranch;
      worktrees.push(entry.branch === expectedBranch
        ? { branch: stableBranch }
        : { branch: stableBranch, currentBranch: entry.branch });
    } else if (entry.branch) {
      worktrees.push({ branch: entry.branch });
    }
  }
  return worktrees;
}

/**
 * Lazily imports pre-registry worktrees, then lists them using the persisted
 * checkout path/expected branch as the authoritative workspace identity.
 */
export async function getRegisteredWorktreeBranches(
  storage: Storage,
  projectId: string,
  projectPath: string,
): Promise<WorktreeBranch[]> {
  const entries = readWorktreeListTolerant(projectPath);
  const sessions = await storage.agentSessions.getProjectedByProjectId(projectId, "runtime");
  const sessionBranches = sessions.map((session) => session.branch);
  const sessionBranchByPath = new Map<string, string>();
  for (const branch of sessionBranches) {
    if (branch) sessionBranchByPath.set(path.resolve(conventionalWorktreePath(projectPath, branch)), branch);
  }

  let registered = await storage.workspaceRegistry.listByProject(projectId, "local");
  const livePaths = new Set(entries.map((entry) => path.resolve(entry.path)));
  for (const row of registered) {
    if (livePaths.has(path.resolve(row.checkout.worktree_path))) continue;
    if (row.checkout.status === "deleting") {
      // Crash recovery: Git removal landed but the registry cleanup did not.
      await storage.workspaceRegistry.markCheckoutDeleted(row.checkout.id);
    } else if (row.checkout.status !== "error" || row.checkout.error !== "Worktree is missing") {
      // The Git list and registry row are separate snapshots. Do not overwrite
      // a create that reached ready after this row was read.
      await storage.workspaceRegistry.setCheckoutStatusIfCurrent(
        row.checkout.id,
        { status: row.checkout.status, updatedAt: row.checkout.updated_at },
        "error",
        "Worktree is missing",
      );
    }
  }
  registered = await storage.workspaceRegistry.listByProject(projectId, "local");
  const registeredPaths = new Set(registered.map((row) => path.resolve(row.checkout.worktree_path)));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const resolvedPath = path.resolve(entry.path);
    const existing = registered.find((row) => path.resolve(row.checkout.worktree_path) === resolvedPath);
    if (existing) {
      // Crash recovery: Git exists but the final DB transition did not land.
      if (existing.checkout.status === "creating" || existing.checkout.status === "error") {
        await storage.workspaceRegistry.setCheckoutStatus(existing.checkout.id, "ready");
      }
      // The root was registered while Git could not name a branch (the project
      // was not a repository yet, or was detached), leaving the "" placeholder.
      // Adopt the branch Git names now so the anchor holds a real expectation
      // instead of reporting every future listing as drift.
      if (index === 0 && existing.checkout.expected_branch === "" && entry.branch) {
        await storage.workspaceRegistry.registerReadyCheckout({
          projectId,
          branch: existing.workspace.branch,
          targetId: "local",
          worktreePath: entry.path,
          expectedBranch: entry.branch,
        });
      }
      continue;
    }
    // A branch-less non-root entry is a detached-HEAD worktree with no stable
    // identity to anchor. The root is different: it is the main workspace even
    // when Git reports no branch (detached HEAD, or not a repository at all),
    // and skipping it would leave the project with nothing to bind against.
    if (registeredPaths.has(resolvedPath) || (entry.branch === null && index > 0)) continue;
    const stableBranch = index === 0
      ? ""
      : (sessionBranchByPath.get(resolvedPath) ?? entry.branch!);
    await storage.workspaceRegistry.registerReadyCheckout({
      projectId,
      branch: stableBranch,
      targetId: "local",
      worktreePath: entry.path,
      expectedBranch: index === 0 ? (entry.branch ?? "") : stableBranch,
    });
    registeredPaths.add(resolvedPath);
  }
  registered = await storage.workspaceRegistry.listByProject(projectId, "local");
  const anchors = registered.map((row: RegisteredWorkspaceCheckout): WorkspaceIdentityAnchor => ({
    branch: row.workspace.branch,
    worktreePath: row.checkout.worktree_path,
    expectedBranch: row.checkout.expected_branch,
  }));
  return reconcileWorktreeBranches(projectPath, entries, sessionBranches, anchors);
}
