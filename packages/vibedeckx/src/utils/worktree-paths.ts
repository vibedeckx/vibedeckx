import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

const WORKTREE_BASE_DIR = "/var/tmp/vibedeckx/worktrees";
const WORKTREE_LIST_TTL_MS = 10_000;

interface CachedWorktreeList {
  entries: Array<{ path: string; branch: string | null }>;
  expiresAt: number;
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

/** Run `git worktree prune` and invalidate the cached list for this project.
 *  Call from list-style API handlers; not on every internal lookup. */
export function pruneWorktrees(projectPath: string): void {
  try {
    execSync("git worktree prune", {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
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

/** Get worktree branches for a project in the API response shape */
export function getWorktreeBranches(projectPath: string): Array<{ branch: string | null }> {
  const entries = parseGitWorktreeList(projectPath);
  const worktrees: Array<{ branch: string | null }> = [{ branch: null }];

  // The first entry (index 0) is always the main worktree — skip it.
  // Add all other worktrees that have a branch name.
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].branch) {
      worktrees.push({ branch: entries[i].branch });
    }
  }

  return worktrees;
}
