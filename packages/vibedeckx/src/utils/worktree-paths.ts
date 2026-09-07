import path from "path";
import { createHash } from "crypto";
import { execSync, execFileSync } from "child_process";
import { mkdirSync, realpathSync } from "fs";
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
  /**
   * Display-only name of the branch the root workspace is anchored to, whose
   * `branch` identity is deliberately null. Absent when the registry holds no
   * real branch for it — never registered, or still on the "" placeholder.
   */
  expectedBranch?: string;
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

/**
 * Both sides of a containment test have to be compared after symlinks, or the
 * same directory reached two ways looks like two places. macOS is the case that
 * matters: `/var` is a symlink to `/private/var`, so Git reports every managed
 * worktree as `/private/var/tmp/vibedeckx/...` while `WORKTREE_BASE_DIR` says
 * `/var/tmp/vibedeckx/...` — string comparison then rejects every one of a Mac
 * worker's own worktrees as untrusted and it reports no workspaces at all.
 * Resolving also tightens the check it exists for: a symlink planted inside the
 * managed base now has to point somewhere still inside it.
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    // Not on disk (yet) — nothing to resolve, and nothing to escape through.
    return path.resolve(target);
  }
}

/** A worktree path is trusted only if it is the project root itself or lives
 *  under this project's own managed worktree base. Git can report stale,
 *  prunable, or otherwise attacker-influenced `.git/worktrees/*` metadata that
 *  points anywhere on disk (e.g. `/etc`); such paths must never be returned to
 *  callers that use them as a filesystem confinement root. */
function isTrustedWorktreePath(projectPath: string, worktreePath: string): boolean {
  const normalizedWorktreePath = canonicalPath(worktreePath);
  if (normalizedWorktreePath === canonicalPath(projectPath)) return true;
  const managedBase = canonicalPath(getWorktreeBaseForProject(projectPath));
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

/** True when `refs/heads/<branch>` exists in this repository. */
function branchExists(projectPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeAddPlan {
  worktreePath: string;
  /** The workspace reuses a branch that was already there, so `startPoint` did not apply. */
  adopted: boolean;
  /** `git worktree add` arguments, or null when the worktree is already on disk. */
  addArgs: string[] | null;
}

/**
 * Decide how `branch` gets a workspace, reusing whatever already exists:
 *
 *   - no such branch        → create it from `startPoint` (`worktree add -b`)
 *   - branch, no worktree   → check the branch out into a new worktree
 *   - branch with worktree  → adopt that worktree as is, touching no Git state
 *
 * A branch left behind by a deleted workspace used to fail the whole create
 * ("Branch 'x' already exists"), which was a dead end: the name was taken on
 * that machine and nothing in the product could free it, so a project whose
 * remotes disagreed about which branches survived could never be brought back
 * into line. Adoption is also what makes create idempotent per target — a retry
 * after a partial multi-target failure converges instead of failing forever on
 * the target that already succeeded.
 *
 * `adopted` is reported rather than hidden: the branch keeps its own history,
 * so the base branch the user picked was ignored and they need to be told.
 *
 * Planning is separate from `applyWorktreeAdd` so callers can register the
 * checkout they are about to create — at its real path — only once the request
 * is known to be viable. A rejection here has touched nothing, on disk or in
 * the registry.
 */
export function planWorktreeAdd(
  projectPath: string,
  branch: string,
  startPoint: string,
): WorktreeAddPlan {
  const exists = branchExists(projectPath, branch);

  if (exists) {
    // Records for directories deleted outside Git otherwise masquerade as live
    // worktrees and would make the branch look un-checkout-able.
    pruneWorktrees(projectPath);
    const existing = parseGitWorktreeList(projectPath).find((e) => e.branch === branch);
    if (existing) {
      // Canonical, not textual: Git reports the resolved path, so a project
      // reached through a symlink would otherwise slip past this guard.
      if (canonicalPath(existing.path) === canonicalPath(projectPath)) {
        // The main workspace already is this branch; a second workspace on the
        // same checkout would be one directory under two identities.
        throw Object.assign(
          new Error(`Branch '${branch}' is checked out in the main workspace`),
          { statusCode: 409 },
        );
      }
      return { worktreePath: existing.path, adopted: true, addArgs: null };
    }
  }

  const worktreePath = resolveWorktreePath(projectPath, branch);
  return {
    worktreePath,
    adopted: exists,
    addArgs: exists
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "-b", branch, worktreePath, startPoint],
  };
}

export interface RetainedBranch {
  branch: string;
  /** Git refused because the branch holds commits no other branch has. */
  unmerged: boolean;
}

/**
 * Delete the branch a just-removed worktree held, and report it when Git keeps
 * it instead. `-d` (never `-D`) is deliberate: a branch with unmerged commits
 * is work the user has not landed anywhere, and deleting a workspace is not
 * consent to throw that away. But the branch surviving is exactly what makes
 * the name unavailable later, so the caller has to be able to say so rather
 * than swallow it — see `planWorktreeAdd`, which reuses such a branch.
 */
export function deleteBranchAfterRemoval(projectPath: string, branch: string): RetainedBranch | null {
  try {
    execFileSync("git", ["branch", "-d", branch], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
    return { branch, unmerged: /not fully merged/i.test(stderr) };
  }
}

/** Carry out a plan from `planWorktreeAdd`. A no-op for an adopted worktree. */
export function applyWorktreeAdd(projectPath: string, plan: WorktreeAddPlan): void {
  if (!plan.addArgs) return;
  mkdirSync(getWorktreeBaseForProject(projectPath), { recursive: true });
  execFileSync("git", plan.addArgs, {
    cwd: projectPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  invalidateWorktreeListCache(projectPath);
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
  // An empty expected branch is the "unknown" placeholder recorded on the
  // other side — the root was registered before the directory became a
  // repository — so it names nothing and is not an expectation either.
  const rootExpectedBranch = rootAnchor?.expectedBranch || undefined;
  // Drift is only claimable when Git actually names a branch. A root with no
  // branch (detached HEAD, or a project directory that is not a repository)
  // has nothing to compare against — reporting it as drifted would be a
  // permanent false positive for non-git projects, and a branch appearing
  // later (git init → main) is adoption, not drift.
  const rootDrifted = rootExpectedBranch !== undefined
    && rootEntry?.branch != null
    && rootEntry.branch !== rootExpectedBranch;
  const root: WorktreeBranch = { branch: null };
  // Named whenever the registry holds a real branch, drifted or not: a label
  // that only materializes on drift would appear to rename the workspace at
  // the very moment the user is comparing it against the live branch.
  if (rootExpectedBranch) root.expectedBranch = rootExpectedBranch;
  if (rootDrifted) root.currentBranch = rootEntry?.branch ?? null;
  const worktrees: WorktreeBranch[] = [root];
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

export type RootAnchorResult =
  | { anchored: true; expectedBranch: string }
  | { anchored: false; currentBranch: string | null };

/**
 * Adopt the branch the main worktree is checked out on as its anchor.
 *
 * The root's expected branch is captured once, at first registration, from
 * whatever Git happened to report then — so a repository sitting on a feature
 * branch that day is anchored there forever, and every later switch reads as
 * drift. Drift detection exists to reveal branch changes the user did not
 * make; this is how the user says "I made this one", without which an
 * intentional switch leaves a warning that can only be cleared by switching
 * back.
 *
 * `observedBranch` is the branch the caller was shown. Git is re-read here and
 * the anchor is refused if it has since moved, so the adopted branch is always
 * the one the user was actually looking at.
 */
export async function anchorRootWorkspaceBranch(
  storage: Storage,
  projectId: string,
  projectPath: string,
  observedBranch: string,
): Promise<RootAnchorResult> {
  invalidateWorktreeListCache(projectPath);
  const rootEntry = readWorktreeListTolerant(projectPath)[0];
  if (!rootEntry || rootEntry.branch !== observedBranch) {
    return { anchored: false, currentBranch: rootEntry?.branch ?? null };
  }
  await storage.workspaceRegistry.registerReadyCheckout({
    projectId,
    branch: "", // The main-workspace identity sentinel; never the branch name.
    targetId: "local",
    worktreePath: rootEntry.path,
    expectedBranch: rootEntry.branch,
  });
  return { anchored: true, expectedBranch: rootEntry.branch };
}

/**
 * Branch names arrive from request bodies — never interpolate one into a shell.
 *
 * `show-ref --verify` matches the ref path exactly. `rev-parse --verify` would
 * instead parse it as a revision, so `dev8^{commit}`, `dev8@{0}` and `main~0`
 * all "exist" — anchoring to one writes an expected branch that can never match
 * a live checkout, leaving the workspace permanently drifted.
 */
function localBranchExists(projectPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export type SetAnchorResult =
  | { anchored: true; expectedBranch: string }
  | { anchored: false; reason: "not-a-repository" | "unknown-branch" | "branch-is-another-workspace" };

/**
 * Point the main workspace's anchor at any branch of the repository, whether or
 * not it is the one checked out right now.
 *
 * `anchorRootWorkspaceBranch` answers "the switch you are looking at was
 * deliberate", so it must match the live branch. This answers a different
 * question — "this workspace belongs to <branch>" — for a project whose anchor
 * was captured from whatever branch it happened to sit on when it was first
 * listed. Without it the only way to correct that anchor is to check the branch
 * out first, which is a Git operation the user may not want yet (the current
 * branch can hold commits and uncommitted work).
 *
 * A mismatch against the live checkout is therefore the expected outcome here,
 * not a failure: it surfaces as ordinary drift (`main → feat/x`) until the user
 * merges or switches on their own.
 */
export async function setRootWorkspaceAnchor(
  storage: Storage,
  projectId: string,
  projectPath: string,
  branch: string,
): Promise<SetAnchorResult> {
  invalidateWorktreeListCache(projectPath);
  const entries = readWorktreeListTolerant(projectPath);
  const rootEntry = entries[0];
  // Tolerant listing fabricates a branch-less root for a non-repository, which
  // has no branches to choose from — reject before asking Git about one.
  if (!rootEntry || !localBranchExists(projectPath, branch)) {
    return { anchored: false, reason: rootEntry ? "unknown-branch" : "not-a-repository" };
  }
  // Another workspace already carries this branch as its identity. Anchoring
  // the root to it too would print two rows under one name, and the sessions
  // bound to each would be indistinguishable in the sidebar.
  const registered = await storage.workspaceRegistry.listByProject(projectId, "local");
  const takenByWorkspace = registered.some((row) => row.workspace.branch !== "" && row.workspace.branch === branch);
  const takenByWorktree = entries.slice(1).some((entry) => entry.branch === branch);
  if (takenByWorkspace || takenByWorktree) {
    return { anchored: false, reason: "branch-is-another-workspace" };
  }
  await storage.workspaceRegistry.registerReadyCheckout({
    projectId,
    branch: "", // The main-workspace identity sentinel; never the branch name.
    targetId: "local",
    worktreePath: rootEntry.path,
    expectedBranch: branch,
  });
  return { anchored: true, expectedBranch: branch };
}
