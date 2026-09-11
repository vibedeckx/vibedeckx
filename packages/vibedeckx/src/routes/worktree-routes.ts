import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { proxyStatus, proxyToRemoteAuto } from "../utils/remote-proxy.js";
import { resolveWorktreePath, conventionalWorktreePath, getRegisteredWorktreeBranches, anchorRootWorkspaceBranch, setRootWorkspaceAnchor, parseGitWorktreeList, probeWorktreeListError, pruneWorktrees, invalidateWorktreeListCache, planWorktreeAdd, applyWorktreeAdd, canonicalPath, deleteBranchAfterRemoval, liveWorktreeRecord, worktreeRecordExists, type RetainedBranch, type SetAnchorResult, type WorktreeBranch } from "../utils/worktree-paths.js";
import { computeWorkspaceMachines, type LinkedMachine, type WorkspaceMachineState } from "../utils/workspace-health.js";
import { ensurePathProjectId } from "../utils/path-project.js";
import { snapshotLiveCheckouts, syncRemoteWorktreeList } from "../workspace-binding-backfill.js";
import { requireUserFacingUserId as requireAuth } from "./user-facing-auth.js";
import "../server-types.js";
import type { Project, RegisteredWorkspaceCheckout } from "../storage/types.js";

interface RemoteConfig {
  serverId: string;
  remotePath: string;
  /** Human name of the remote server, for per-target result messages. */
  serverName: string;
  /** The hub has registered this remote's complete worktree list at least once. */
  worktreesSynced: boolean;
}

async function getAllRemoteConfigs(fastify: FastifyInstance, project: Project): Promise<RemoteConfig[]> {
  const remotes = await fastify.storage.projectRemotes.getByProject(project.id);
  return remotes.map((r) => ({
    serverId: r.remote_server_id,
    remotePath: r.remote_path,
    serverName: r.server_name,
    worktreesSynced: r.worktrees_synced_at !== null,
  }));
}

/**
 * The remote the project's sessions run on — `agent_mode` — which is also the
 * one whose Git the worktree list should come from. The primary (first-linked)
 * remote is only the fallback for an `agent_mode` that names nothing linked.
 */
function currentRemote(project: Project, remotes: RemoteConfig[]): RemoteConfig | null {
  if (remotes.length === 0) return null;
  return remotes.find((remote) => remote.serverId === project.agent_mode) ?? remotes[0];
}

/** `agent_mode` names a remote the project no longer has (or none at all). */
function activeRemoteInvalid(project: Project, remotes: RemoteConfig[]): boolean {
  return !remotes.some((remote) => remote.serverId === project.agent_mode);
}

/**
 * Every machine the project has, in the order the UI lists them. The local
 * path counts as a machine that is always synced: its list is read straight
 * from Git, never from a cache of some earlier report.
 */
function linkedMachines(project: Project, remotes: RemoteConfig[]): LinkedMachine[] {
  const linked: LinkedMachine[] = [];
  if (project.path) linked.push({ serverId: "local", name: "local", synced: true });
  for (const remote of remotes) {
    linked.push({ serverId: remote.serverId, name: remote.serverName, synced: remote.worktreesSynced });
  }
  return linked;
}

/**
 * Per-target outcome of a multi-target create/delete. The map key stays the
 * wire-compatible one ("local", "remote" for a single remote, otherwise the
 * remote server id); `label` carries the name to show for that key, since a
 * caller holding only a server id cannot name it.
 */
interface TargetCreateResult {
  success: boolean;
  label: string;
  /** The machine itself: "local" or a remote server id. */
  targetId: string;
  worktree?: { branch: string };
  /** This target reused a branch that already existed there. */
  adopted?: boolean;
  error?: string;
  errorCode?: string;
  requestId?: string;
}

interface TargetDeleteResult {
  success: boolean;
  label: string;
  /** The machine itself: "local" or a remote server id, so a caller can act on it. */
  targetId: string;
  /** Set when Git kept the branch (unmerged work), so the name stays taken. */
  branchRetained?: RetainedBranch | null;
  error?: string;
}

/** The current remote's config (see `currentRemote`), or null. Used by endpoints that operate on a single remote. */
async function getRemoteConfig(fastify: FastifyInstance, project: Project): Promise<RemoteConfig | null> {
  return currentRemote(project, await getAllRemoteConfigs(fastify, project));
}

/** HTTP shape of an explicit anchor that Git or the workspace list refused. */
function anchorFailure(
  reason: Extract<SetAnchorResult, { anchored: false }>["reason"],
  branch: string,
): { code: number; error: string } {
  switch (reason) {
    case "unknown-branch":
      return { code: 400, error: `Branch '${branch}' does not exist in this repository` };
    case "branch-is-another-workspace":
      return { code: 409, error: `'${branch}' already has its own workspace` };
    case "not-a-repository":
      return { code: 400, error: "The main workspace is not a Git repository" };
  }
}

async function ensurePathProject(fastify: FastifyInstance, projectPath: string): Promise<Project> {
  const projectId = await ensurePathProjectId(fastify, projectPath);
  const project = await fastify.storage.projects.getById(projectId);
  if (!project) throw new Error(`Path project '${projectId}' was not persisted`);
  return project;
}

/**
 * Put a checkout back the way it was before a delete that did not land.
 *
 * A failed delete describes the operation, not the health of the checkout: the
 * worktree is still there and still usable, so recording it as broken says the
 * wrong thing — and says it in the same field a failed *create* uses, which is
 * the one signal that tells "this machine never got the workspace" apart from
 * "this machine would not give it up".
 *
 * The reason still goes into `error`, which the two fields make unambiguous
 * together: `status` says whether the checkout can be used, `error` says what
 * went wrong last. Without it the reason would live only in the answer to the
 * delete that failed — gone the moment that window closes, leaving a marked
 * workspace whose mark says nothing about what to do.
 *
 * Only a row still sitting in `deleting` is restored: anything else means
 * something newer has since claimed it.
 */
async function restoreCheckoutAfterFailedDelete(
  fastify: FastifyInstance,
  registered: RegisteredWorkspaceCheckout,
  reason: string,
): Promise<void> {
  const current = await fastify.storage.workspaceRegistry.getCheckoutById(registered.checkout.id);
  if (!current || current.checkout.status !== "deleting") return;
  await fastify.storage.workspaceRegistry.setCheckoutStatusIfCurrent(
    registered.checkout.id,
    { status: "deleting", updatedAt: current.checkout.updated_at },
    registered.checkout.status,
    // A checkout that was already broken keeps the reason it is broken: that is
    // what its `error` means while `status` is error, and it outranks the news
    // that a delete of it also failed.
    registered.checkout.status === "ready" ? reason : registered.checkout.error,
  );
}

/** The worktree array out of a worker's list response, tolerating an old or odd shape. */
function listedWorktrees(data: unknown): WorktreeBranch[] {
  const worktrees = (data as { worktrees?: unknown })?.worktrees;
  return Array.isArray(worktrees) ? worktrees as WorktreeBranch[] : [];
}

/** A machine's answer to "do you have this workspace?", or its last-known state when it could not answer. */
interface WorkspaceMachineCheck extends WorkspaceMachineState {
  /** The worker was actually asked. False = `state` is the registry's last-known view. */
  checked: boolean;
  /** Why it could not be asked: offline, timed out, or the worker's own error. */
  checkError?: string;
}

/** Per-machine ceiling for the parallel live check; the dialog is waiting on it. */
const MACHINE_CHECK_TIMEOUT_MS = 15_000;

/** One row of the project worktree list, with the registry's cross-machine view attached. */
type ListedWorktree = WorktreeBranch & {
  /** Every linked machine's state; never sent for the main workspace. */
  machines?: WorkspaceMachineState[];
};

/** The registry's cross-machine view of a project, over the machines it still has. */
async function projectMachines(
  fastify: FastifyInstance,
  project: Project,
): Promise<{ linked: LinkedMachine[]; byBranch: Map<string, WorkspaceMachineState[]> }> {
  const remotes = await getAllRemoteConfigs(fastify, project);
  // Only machines the project still has. Unlinking a remote leaves its
  // checkout rows behind, and one of those reads as "still there" on a machine
  // nothing can act on any more.
  const linked = linkedMachines(project, remotes);
  const linkedIds = new Set(linked.map((machine) => machine.serverId));
  const rows = (await fastify.storage.workspaceRegistry.listByProject(project.id, undefined, { includeDeleted: true }))
    .filter((row) => linkedIds.has(row.checkout.target_id));
  return { linked, byBranch: computeWorkspaceMachines(rows, linked) };
}

/** A workspace with a live row somewhere is still a workspace; one with none left anywhere is gone. */
function heldSomewhere(machines: WorkspaceMachineState[]): boolean {
  return machines.some((machine) => machine.state !== "absent" && machine.state !== "unknown");
}

/** Only the Git facts of a worker's entry: its path and anything else it adds stay on the worker. */
function gitFacts(worktree: WorktreeBranch): WorktreeBranch {
  return {
    branch: worktree.branch,
    ...(worktree.currentBranch !== undefined ? { currentBranch: worktree.currentBranch } : {}),
    ...(worktree.expectedBranch !== undefined ? { expectedBranch: worktree.expectedBranch } : {}),
  };
}

/**
 * Merge the registry's cross-machine view into one machine's worktree list.
 *
 * The list itself is one machine's Git, while a workspace may deliberately
 * exist on only some of the project's machines. Every workspace is therefore
 * annotated with a per-machine breakdown, and one the listing machine does
 * not have — created elsewhere only, or a delete that failed somewhere else —
 * is appended, so it stays reachable in the UI instead of being invisible
 * while it is on disk over there.
 */
async function withWorkspaceHealth(
  fastify: FastifyInstance,
  project: Project,
  worktrees: WorktreeBranch[],
): Promise<ListedWorktree[]> {
  const { byBranch } = await projectMachines(fastify, project);
  const merged: ListedWorktree[] = worktrees.map((worktree) => {
    // The registry stores the main workspace as "", the list calls it null —
    // and it is on every machine by definition, so it carries no `machines`.
    const machines = worktree.branch === null ? undefined : byBranch.get(worktree.branch);
    return { ...gitFacts(worktree), ...(machines ? { machines } : {}) };
  });
  const listed = new Set(worktrees.map((worktree) => worktree.branch));
  for (const [branch, machines] of byBranch) {
    if (branch === "" || listed.has(branch) || !heldSomewhere(machines)) continue;
    merged.push({ branch, machines });
  }
  return merged;
}

/**
 * The project's worktree list with the registry as the source of truth and
 * the current remote's Git as the correction (design §5.1): every workspace
 * the registry holds a live row for, on any linked machine, is listed — the
 * machine that happened to be linked first no longer decides what is
 * visible. The current remote's own entries, when it answered, carry its
 * Git facts (drift, the main workspace's anchor) and set the order; the rest
 * follow by name.
 */
async function registryWorktreeList(
  fastify: FastifyInstance,
  project: Project,
  reported: WorktreeBranch[] | null,
): Promise<ListedWorktree[]> {
  const { byBranch } = await projectMachines(fastify, project);
  const rootFromWorker = reported?.find((worktree) => worktree.branch === null);
  const list: ListedWorktree[] = [rootFromWorker ? gitFacts(rootFromWorker) : { branch: null }];
  const placed = new Set<string>();
  for (const worktree of reported ?? []) {
    if (worktree.branch === null) continue;
    const machines = byBranch.get(worktree.branch);
    // Reconciliation has just registered whatever the worker listed, so a
    // missing entry can only mean a row nothing could write; list it bare.
    list.push({ ...gitFacts(worktree), ...(machines ? { machines } : {}) });
    placed.add(worktree.branch);
  }
  const rest = [...byBranch]
    .filter(([branch, machines]) => branch !== "" && !placed.has(branch) && heldSomewhere(machines))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [branch, machines] of rest) list.push({ branch, machines });
  return list;
}

/**
 * Remove the worktree, treating "it was already gone" as done rather than as a
 * failure — a partial multi-target delete otherwise traps the user: retrying
 * fails on the target that already succeeded, and no click ever converges.
 *
 * The evidence for "already gone" is Git's answer *after* the attempt, not a
 * pre-check. `git worktree remove` reporting `not a working tree` is not proof
 * on its own (the path could be wrong, and the state can change between a check
 * and the removal), and a re-query that cannot reach Git proves nothing either
 * — both keep the original error. Only a live, uncached, unfiltered record
 * saying no such worktree exists lets the failure be swallowed, and the stale
 * record that a hand-deleted directory leaves behind is pruned so it stops
 * holding the branch.
 */
function removeWorktreeIfPresent(
  execFileSync: typeof import("child_process").execFileSync,
  projectPath: string,
  worktreePath: string,
): void {
  try {
    execFileSync("git", ["worktree", "remove", worktreePath], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (worktreeRecordExists(projectPath, worktreePath) !== false) throw error;
    pruneWorktrees(projectPath);
  }
}

/**
 * Refuse to hand one directory to a second workspace identity.
 *
 * A checkout keeps its identity when an agent switches its branch — workspace
 * `dev` whose tree now sits on `topic` still owns that directory. Adopting by
 * live branch alone would then register `topic` against the same path, and a
 * later delete of either workspace would remove the other's checkout.
 */
async function assertPathIsFree(
  fastify: FastifyInstance,
  opts: { projectId: string; branch: string; targetId: string; worktreePath: string },
): Promise<void> {
  const registered = await fastify.storage.workspaceRegistry.listByProject(opts.projectId, opts.targetId);
  const target = canonicalPath(opts.worktreePath);
  const owner = registered.find((row) =>
    row.workspace.branch !== opts.branch
    && canonicalPath(row.checkout.worktree_path) === target);
  if (!owner) return;
  throw Object.assign(
    new Error(
      `That worktree already belongs to workspace '${owner.workspace.branch || "main"}'`,
    ),
    { statusCode: 409 },
  );
}

/**
 * The worktree still holds something we could not confirm dead, so the delete
 * was refused. The checkout itself is healthy — this describes the operation,
 * not the checkout — so callers restore its previous status rather than
 * marking it in error.
 */
class WorktreeBusyError extends Error {}

/**
 * Kill everything still executing inside a worktree that is about to be
 * removed, and confirm it is actually gone. Without this, `git worktree
 * remove` deletes the directory out from under a live agent child process and
 * any running executor/terminal PTYs, which keep running with a cwd that no
 * longer exists.
 *
 * Called after the uncommitted-changes check, so a refused delete never costs
 * the user a running agent, and before `git worktree remove`.
 *
 * Both stops wait for the process to exit and escalate to SIGKILL rather than
 * just firing SIGTERM, because a signal that has merely been delivered says
 * nothing about whether the tree is free yet. Anything still alive after the
 * escalation raises `WorktreeBusyError`: removing the directory anyway is the
 * exact orphaning this function exists to prevent, and a retry will normally
 * succeed since the survivor has by then been SIGKILLed.
 *
 * Sessions are matched by (projectId, branch). `projectIds` is a candidate set
 * rather than one id because `projects.path` carries no UNIQUE constraint: on a
 * reverse-connect worker a session may be registered under either a real
 * project row sharing the path or the `path:<path>` pseudo-project, and
 * `ensurePathProjectId` and `getByPath` can pick different ones. Processes are
 * matched by cwd — see `getRunningProcessIdsUnderPath` for why branch is not
 * usable there. Interactive terminals in the worktree are stopped along with
 * executor runs: their cwd is about to disappear too.
 */
async function stopWorkspaceActivity(
  fastify: FastifyInstance,
  opts: { projectIds: Array<string | undefined>; branch: string; worktreePath: string },
): Promise<void> {
  const sessionIds = [...new Set(
    opts.projectIds
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => fastify.agentSessionManager.getLiveSessionIdsForBranch(id, opts.branch)),
  )];
  const processIds = fastify.processManager.getRunningProcessIdsUnderPath(opts.worktreePath);
  if (sessionIds.length === 0 && processIds.length === 0) return;

  // A stop that throws counts as unconfirmed, same as one that times out —
  // both leave a process that may still be alive in the tree.
  const survivors: string[] = [];
  const confirm = async (label: string, stop: () => Promise<boolean>) => {
    try {
      if (!await stop()) survivors.push(label);
    } catch (error) {
      console.error(`[worktree] Failed to stop ${label} before delete:`, error);
      survivors.push(label);
    }
  };

  // Sessions first, then processes; within each group concurrently, so the
  // grace windows overlap instead of summing.
  await Promise.all(sessionIds.map((sessionId) => confirm(`session ${sessionId}`, () =>
    fastify.agentSessionManager.stopSessionAndWait(sessionId, {
      note: "Session stopped: its worktree is being deleted.",
    }))));
  await Promise.all(processIds.map((processId) => confirm(`process ${processId}`, () =>
    fastify.processManager.stopAndWait(processId))));

  if (survivors.length > 0) {
    throw new WorktreeBusyError(
      `Worktree still has running work that could not be stopped (${survivors.join(", ")}). `
      + "Nothing was deleted; retry in a moment.",
    );
  }
  console.log(
    `[worktree] Stopped ${sessionIds.length} session(s) and ${processIds.length} process(es) in ${opts.worktreePath}`,
  );
}

const routes: FastifyPluginAsync = async (fastify) => {
  // ==================== Path-based worktree API ====================

  // Get branches for a path
  fastify.get<{
    Querystring: { path: string };
  }>("/api/path/branches", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      const { execSync } = await import("child_process");
      const output = execSync("git branch --format='%(refname:short)'", {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const branches = output
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      return reply.code(200).send({ branches });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list branches: ${errorMessage}` });
    }
  });

  // Get worktrees for a path
  fastify.get<{
    Querystring: { path: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      return reply.code(400).send({ error: "Path is required" });
    }

    try {
      pruneWorktrees(projectPath);
      // A repository Git cannot read lists as root-only, same as a directory
      // that is no repository. The hub reconciles its registry against this
      // answer, so it must be able to tell the two apart: `gitError` marks the
      // list as a fallback, not a fact. Additive field — old hubs ignore it.
      const gitError = probeWorktreeListError(projectPath);
      const project = await ensurePathProject(fastify, projectPath);
      const worktrees = await getRegisteredWorktreeBranches(fastify.storage, project.id, projectPath);
      const registered = await fastify.storage.workspaceRegistry.listByProject(project.id, "local");
      const pathByBranch = new Map(registered.map((row) => [row.workspace.branch, row.checkout.worktree_path]));
      return reply.code(200).send({
        worktrees: worktrees.map((worktree) => ({
          ...worktree,
          worktreePath: pathByBranch.get(worktree.branch ?? ""),
        })),
        ...(gitError ? { gitError } : {}),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list worktrees: ${errorMessage}` });
    }
  });

  // Create worktree at a path
  fastify.post<{
    Body: { path: string; branchName: string; baseBranch?: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const { path: projectPath, branchName, baseBranch } = req.body;
    const requestId = req.headers["x-request-id"] || "local";

    if (!projectPath || !branchName) {
      return reply.code(400).send({ error: "Path and branchName are required" });
    }

    const trimmedBranch = branchName.trim();
    if (!/^[a-zA-Z0-9]/.test(trimmedBranch) || /[^a-zA-Z0-9/_-]/.test(trimmedBranch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const startPoint = baseBranch?.trim() || "main";
    if (/[^a-zA-Z0-9/_.\-]/.test(startPoint)) {
      return reply.code(400).send({ error: "Invalid base branch name format" });
    }

    console.log(`[worktree] ${requestId} Creating: branch=${trimmedBranch}, base=${startPoint}, path=${projectPath}`);

    let pendingCheckoutId: string | null = null;
    try {
      // An existing branch is reused rather than refused; `adopted` says which
      // happened, since an adopted branch ignores the requested base.
      const plan = planWorktreeAdd(projectPath, trimmedBranch, startPoint);
      const project = await ensurePathProject(fastify, projectPath);
      await assertPathIsFree(fastify, {
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: plan.worktreePath,
      });
      const pending = await fastify.storage.workspaceRegistry.beginCheckout({
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: plan.worktreePath,
        expectedBranch: trimmedBranch,
      });
      pendingCheckoutId = pending.checkout.id;

      applyWorktreeAdd(projectPath, plan);
      await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");

      console.log(`[worktree] ${requestId} ${plan.adopted ? "Adopted" : "Created"}: branch=${trimmedBranch}`);

      return reply.code(201).send({
        worktree: { branch: trimmedBranch, worktreePath: plan.worktreePath, adopted: plan.adopted },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (pendingCheckoutId) {
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(pendingCheckoutId, "error", errorMessage)
          .catch((registryError) => console.error("[worktree] Failed to record checkout error:", registryError));
      }
      const stderr = (error as { stderr?: string })?.stderr || "";
      console.error(`[worktree] ${requestId} Failed: ${errorMessage}${stderr ? `, stderr: ${stderr}` : ""}`);
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode) return reply.code(statusCode).send({ error: errorMessage });
      return reply.code(500).send({ error: `Failed to create worktree: ${errorMessage}` });
    }
  });

  // Delete worktree at a path
  fastify.delete<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees", async (req, reply) => {
    const { path: projectPath, branch } = req.body;
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    if (!/^[a-zA-Z0-9]/.test(branch) || /[^a-zA-Z0-9/_-]/.test(branch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const pathProject = await fastify.storage.projects.getByPath(projectPath);
    const registered = pathProject
      ? await fastify.storage.workspaceRegistry.getByProjectBranch(pathProject.id, branch, "local")
      : undefined;
    if (registered) {
      await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
    }
    let worktreeRemoved = false;
    try {
      const { execSync, execFileSync } = await import("child_process");
      const worktreeAbsPath = resolveWorktreePath(projectPath, branch);

      try {
        const statusOutput = execSync("git status --porcelain", {
          cwd: worktreeAbsPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (statusOutput.trim() !== "") {
          if (registered) {
            await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "ready");
          }
          return reply.code(409).send({
            error: "Worktree has uncommitted changes",
          });
        }
      } catch {
        // Continue with deletion
      }

      await stopWorkspaceActivity(fastify, {
        projectIds: [pathProject?.id, `path:${projectPath}`],
        branch,
        worktreePath: worktreeAbsPath,
      });

      // The branch Git records for this tree, falling back to the workspace's
      // own name when there is no record (or Git cannot say).
      let branchToDelete = branch;
      try {
        branchToDelete = liveWorktreeRecord(projectPath, worktreeAbsPath)?.branch ?? branch;
      } catch {
        // Fall back to the requested branch.
      }

      removeWorktreeIfPresent(execFileSync, projectPath, worktreeAbsPath);
      worktreeRemoved = true;
      invalidateWorktreeListCache(projectPath);

      // A branch Git keeps is the thing that makes this name unavailable later,
      // so it travels back to the user rather than being swallowed here.
      const branchRetained = branchToDelete ? deleteBranchAfterRemoval(projectPath, branchToDelete) : null;

      if (registered) {
        await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
      }

      return reply.code(200).send({ success: true, branchRetained });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // A busy worktree is a refusal, not a broken checkout: restore the prior
      // status like the uncommitted-changes path does, and report it as a
      // conflict so the UI does not present it as a server fault.
      const busy = error instanceof WorktreeBusyError;
      if (registered && !worktreeRemoved) {
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(registered.checkout.id, busy ? "ready" : "error", busy ? null : errorMessage)
          .catch((registryError) => console.error("[worktree] Failed to record delete error:", registryError));
      }
      if (busy) return reply.code(409).send({ error: errorMessage });
      return reply.code(500).send({ error: `Failed to delete worktree: ${errorMessage}` });
    }
  });

  // Adopt the main worktree's live branch as its anchor, clearing the drift
  // warning for a switch the user made on purpose.
  fastify.post<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees/anchor", async (req, reply) => {
    const { path: projectPath, branch } = req.body ?? {};
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    try {
      const project = await ensurePathProject(fastify, projectPath);
      const result = await anchorRootWorkspaceBranch(fastify.storage, project.id, projectPath, branch);
      if (!result.anchored) {
        return reply.code(409).send({
          error: `The main workspace is on '${result.currentBranch ?? "detached HEAD"}', not '${branch}'`,
          currentBranch: result.currentBranch,
        });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Set the main workspace's anchor to a branch the user picked, which need not
  // be the one checked out — the resulting drift is the point (see
  // setRootWorkspaceAnchor). Separate from /anchor so an old worker 404s it
  // instead of applying that route's live-branch guard to a different intent.
  fastify.post<{
    Body: { path: string; branch: string };
  }>("/api/path/worktrees/anchor-branch", async (req, reply) => {
    const { path: projectPath, branch } = req.body ?? {};
    if (!projectPath || !branch) {
      return reply.code(400).send({ error: "Path and branch are required" });
    }

    try {
      const project = await ensurePathProject(fastify, projectPath);
      const result = await setRootWorkspaceAnchor(fastify.storage, project.id, projectPath, branch);
      if (!result.anchored) {
        const failure = anchorFailure(result.reason, branch);
        return reply.code(failure.code).send({ error: failure.error });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // ==================== Project-based worktree API ====================

  // 获取项目的 worktrees
  fastify.get<{ Params: { id: string }; Querystring: { target?: string } }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const requestedTarget = req.query.target ?? "local";
    if (requestedTarget !== "local") {
      // One named machine's own list. Its rows are reconciled to it: this is
      // that machine's complete answer.
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      const snapshot = await snapshotLiveCheckouts(fastify.storage, project.id, targetRemote.remote_server_id);
      const result = await proxyToRemoteAuto(
        targetRemote.remote_server_id,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(targetRemote.remote_path)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      if (result.ok) {
        await syncRemoteWorktreeList(fastify.storage, project.id, {
          serverId: targetRemote.remote_server_id,
          remotePath: targetRemote.remote_path,
        }, result.data, snapshot);
        return reply.code(200).send({
          worktrees: await withWorkspaceHealth(fastify, project, listedWorktrees(result.data)),
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    // A remote-only project: the registry is the list, and the current
    // remote — the machine sessions run on — is asked for its Git so its rows
    // are reconciled and its facts (drift, the anchor) ride along. One that
    // cannot answer makes the list `stale`, not a failure: the registry still
    // knows what is where.
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const remoteConfig = currentRemote(project, remoteConfigs);
    if (!project.path && remoteConfig) {
      const snapshot = await snapshotLiveCheckouts(fastify.storage, project.id, remoteConfig.serverId);
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "GET",
        `/api/path/worktrees?path=${encodeURIComponent(remoteConfig.remotePath)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      let reported: WorktreeBranch[] | null = null;
      if (result.ok && await syncRemoteWorktreeList(fastify.storage, project.id, remoteConfig, result.data, snapshot)) {
        reported = listedWorktrees(result.data);
      }
      return reply.code(200).send({
        worktrees: await registryWorktreeList(fastify, project, reported),
        ...(reported ? {} : { stale: { serverId: remoteConfig.serverId, name: remoteConfig.serverName } }),
        ...(activeRemoteInvalid(project, remoteConfigs) ? { activeRemoteInvalid: true } : {}),
      });
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      pruneWorktrees(project.path);
      const listed = await getRegisteredWorktreeBranches(fastify.storage, project.id, project.path);
      return reply.code(200).send({ worktrees: await withWorkspaceHealth(fastify, project, listed) });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list worktrees: ${errorMessage}` });
    }
  });

  // Where one workspace is right now, machine by machine: every linked remote
  // is asked for its worktree list in parallel. This is the repair dialog's
  // opening question, and it is asked here rather than through `?target=`
  // per machine because that list is not one machine's pure answer —
  // `withWorkspaceHealth` appends workspaces held only elsewhere, so "the
  // branch is in the response" would not mean "this machine has it".
  fastify.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    "/api/projects/:id/worktrees/machines",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const project = await fastify.storage.projects.getById(req.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }
      // The main workspace is on every machine by definition; there is
      // nothing to manage.
      const branch = req.query.branch?.trim();
      if (!branch) return reply.code(400).send({ error: "Branch is required" });

      const remotes = await getAllRemoteConfigs(fastify, project);
      const linked = linkedMachines(project, remotes);
      // The registry's last-known view, read before anything is registered
      // below: a machine that cannot be reached answers with this, and a
      // machine whose row says an operation is under way (or failed) keeps
      // that answer even when its Git already lists the branch — retrying is
      // what clears an error, not a listing.
      const rows = (await fastify.storage.workspaceRegistry.listByProject(project.id, undefined, { includeDeleted: true }))
        .filter((row) => row.workspace.branch === branch);
      const known = new Map(
        (computeWorkspaceMachines(rows, linked).get(branch)
          ?? linked.map((machine) => ({
            serverId: machine.serverId,
            name: machine.name,
            state: machine.synced ? "absent" as const : "unknown" as const,
          })))
          .map((machine) => [machine.serverId, machine]),
      );

      const settle = (
        machine: WorkspaceMachineState,
        listed: boolean,
      ): WorkspaceMachineCheck => {
        if (machine.state === "creating" || machine.state === "deleting" || machine.state === "error") {
          return { ...machine, checked: true };
        }
        if (listed) return { serverId: machine.serverId, name: machine.name, state: "present", checked: true };
        return {
          serverId: machine.serverId,
          name: machine.name,
          state: "absent",
          ...(machine.deleted ? { deleted: true } : {}),
          checked: true,
        };
      };
      const unreachable = (machine: WorkspaceMachineState, checkError: string): WorkspaceMachineCheck =>
        ({ ...machine, checked: false, checkError });

      const checks = await Promise.all(linked.map(async (machine): Promise<WorkspaceMachineCheck> => {
        const state = known.get(machine.serverId)!;
        if (machine.serverId === "local") {
          try {
            pruneWorktrees(project.path!);
            const listed = await getRegisteredWorktreeBranches(fastify.storage, project.id, project.path!);
            return settle(state, listed.some((worktree) => worktree.branch === branch));
          } catch (error) {
            return unreachable(state, error instanceof Error ? error.message : "Failed to list worktrees");
          }
        }
        const remote = remotes.find((rc) => rc.serverId === machine.serverId)!;
        try {
          const result = await proxyToRemoteAuto(
            remote.serverId,
            "GET",
            `/api/path/worktrees?path=${encodeURIComponent(remote.remotePath)}`,
            undefined,
            { reverseConnectManager: fastify.reverseConnectManager, timeoutMs: MACHINE_CHECK_TIMEOUT_MS },
          );
          if (!result.ok) {
            const detail = (result.data as { error?: string } | undefined)?.error;
            return unreachable(state, detail || result.errorCode || `Worker answered ${result.status}`);
          }
          // Same side effect as listing that machine: what it reports is
          // registered (add-only) and the machine counts as confirmed.
          if (!await syncRemoteWorktreeList(fastify.storage, project.id, remote, result.data)) {
            return unreachable(state, "Worker returned no worktree list");
          }
          return settle(state, listedWorktrees(result.data).some((worktree) => worktree.branch === branch));
        } catch (error) {
          return unreachable(state, error instanceof Error ? error.message : "Failed to reach the worker");
        }
      }));

      return reply.code(200).send({ branch, machines: checks });
    },
  );

  // Anchor the main workspace to the branch it is checked out on now
  fastify.post<{
    Params: { id: string };
    Body: { branch: string; target?: string };
  }>("/api/projects/:id/worktrees/anchor", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    if (!branch) return reply.code(400).send({ error: "Branch is required" });

    const requestedTarget = req.body.target ?? "local";
    let remoteConfig: RemoteConfig | null;
    if (requestedTarget === "local") {
      // A project with no local path is remote-only: "local" means its remote.
      remoteConfig = project.path ? null : await getRemoteConfig(fastify, project);
    } else {
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      remoteConfig = {
        serverId: targetRemote.remote_server_id,
        remotePath: targetRemote.remote_path,
        serverName: targetRemote.server_name,
        worktreesSynced: targetRemote.worktrees_synced_at !== null,
      };
    }

    if (remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "POST",
        "/api/path/worktrees/anchor",
        { path: remoteConfig.remotePath, branch },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      // Additive route: a worker that predates it 404s. Say so, rather than
      // letting the UI report the workspace as missing.
      if (result.status === 404) {
        return reply.code(501).send({
          error: "This remote worker is too old to anchor a workspace. Update it and try again.",
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const result = await anchorRootWorkspaceBranch(fastify.storage, project.id, project.path, branch);
      if (!result.anchored) {
        return reply.code(409).send({
          error: `The main workspace is on '${result.currentBranch ?? "detached HEAD"}', not '${branch}'`,
          currentBranch: result.currentBranch,
        });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Rename the main workspace to a branch the user picked from its branch list,
  // independent of what is checked out there.
  fastify.post<{
    Params: { id: string };
    Body: { branch: string; target?: string };
  }>("/api/projects/:id/worktrees/anchor-branch", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const branch = req.body?.branch;
    if (!branch) return reply.code(400).send({ error: "Branch is required" });

    const requestedTarget = req.body.target ?? "local";
    let remoteConfig: RemoteConfig | null;
    if (requestedTarget === "local") {
      // A project with no local path is remote-only: "local" means its remote.
      remoteConfig = project.path ? null : await getRemoteConfig(fastify, project);
    } else {
      const targetRemote = await fastify.storage.projectRemotes.getByProjectAndServer(project.id, requestedTarget);
      if (!targetRemote) return reply.code(400).send({ error: "Unknown remote target" });
      remoteConfig = {
        serverId: targetRemote.remote_server_id,
        remotePath: targetRemote.remote_path,
        serverName: targetRemote.server_name,
        worktreesSynced: targetRemote.worktrees_synced_at !== null,
      };
    }

    if (remoteConfig) {
      const result = await proxyToRemoteAuto(
        remoteConfig.serverId,
        "POST",
        "/api/path/worktrees/anchor-branch",
        { path: remoteConfig.remotePath, branch },
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      // Additive route: a worker that predates it 404s. Say so, rather than
      // letting the UI report the workspace as missing.
      if (result.status === 404) {
        return reply.code(501).send({
          error: "This remote worker is too old to change a workspace branch. Update it and try again.",
        });
      }
      return reply.code(proxyStatus(result)).send(result.data);
    }

    if (!project.path) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const result = await setRootWorkspaceAnchor(fastify.storage, project.id, project.path, branch);
      if (!result.anchored) {
        const failure = anchorFailure(result.reason, branch);
        return reply.code(failure.code).send({ error: failure.error });
      }
      return reply.code(200).send({ expectedBranch: result.expectedBranch });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to anchor workspace: ${errorMessage}` });
    }
  });

  // Get branches for a project
  fastify.get<{
    Params: { id: string };
    // `target` names one machine: "local", a remote server id, or the legacy
    // "remote" (the project's primary remote).
    Querystring: { target?: string };
  }>("/api/projects/:id/branches", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const target = req.query.target || "local";
    const hasLocal = !!project.path;
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const remoteConfig = remoteConfigs[0] ?? null;
    const hasRemote = !!remoteConfig;

    const proxyBranchesTo = async (rc: RemoteConfig) => {
      const result = await proxyToRemoteAuto(
        rc.serverId,
        "GET",
        `/api/path/branches?path=${encodeURIComponent(rc.remotePath)}`,
        undefined,
        { reverseConnectManager: fastify.reverseConnectManager }
      );
      return reply.code(proxyStatus(result)).send(result.data);
    };

    const proxyBranchesToRemote = async () => proxyBranchesTo(remoteConfig!);

    if (target === "remote") {
      if (!hasRemote) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      return proxyBranchesToRemote();
    }

    if (target !== "local") {
      // A named remote: with several linked, "the remote" is not an answer —
      // a base branch that only lives on the third one is still a valid start
      // point for a workspace created there.
      const named = remoteConfigs.find((rc) => rc.serverId === target);
      if (!named) {
        return reply.code(400).send({ error: `Unknown target '${target}'` });
      }
      return proxyBranchesTo(named);
    }

    // target === "local"
    if (!hasLocal && hasRemote) {
      // Remote-only project: proxy to remote
      return proxyBranchesToRemote();
    }

    if (!hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    try {
      const { execSync } = await import("child_process");
      const output = execSync("git branch --format='%(refname:short)'", {
        cwd: project.path!,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const branches = output
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      return reply.code(200).send({ branches });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.code(500).send({ error: `Failed to list branches: ${errorMessage}` });
    }
  });

  // 删除 git worktree
  fastify.delete<{
    Params: { id: string };
    Body: { branch: string };
  }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branch } = req.body;

    if (!branch || typeof branch !== "string" || branch.trim() === "") {
      return reply.code(400).send({ error: "Branch is required" });
    }

    if (!/^[a-zA-Z0-9]/.test(branch) || /[^a-zA-Z0-9/_-]/.test(branch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const hasLocal = !!project.path;
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const hasRemote = remoteConfigs.length > 0;

    // Helper to delete worktree on a single remote
    const deleteOnRemote = async (rc: RemoteConfig) => {
      const registered = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, branch, rc.serverId);
      const restorePreviousStatus = async (reason: string) => {
        if (!registered) return;
        await restoreCheckoutAfterFailedDelete(fastify, registered, reason);
      };
      if (registered) {
        await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
      }
      try {
        const result = await proxyToRemoteAuto(
          rc.serverId,
          "DELETE",
          `/api/path/worktrees`,
          { path: rc.remotePath, branch },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (registered) {
          if (result.ok) {
            await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
          } else {
            // A failed delete describes the operation, not checkout health.
            // This includes explicit refusal, worker 5xx, and transport
            // failures where the remote outcome is unknown.
            const detail = result.data as { error?: string };
            await restorePreviousStatus(detail?.error || result.errorCode || "Remote deletion failed");
          }
        }
        return result;
      } catch (error) {
        if (registered) {
          await restorePreviousStatus(error instanceof Error ? error.message : "Remote deletion failed")
            .catch((registryError) => console.error("[worktree] Failed to restore remote checkout status:", registryError));
        }
        throw error;
      }
    };

    // Remote-only project: delete from all remotes
    if (!hasLocal && hasRemote) {
      if (remoteConfigs.length === 1) {
        // Single remote: backward-compatible flat response
        const result = await deleteOnRemote(remoteConfigs[0]);
        return reply.code(proxyStatus(result)).send(result.data);
      }

      // Multiple remotes: delete from all in parallel
      const results: Record<string, TargetDeleteResult> = {};
      await Promise.allSettled(
        remoteConfigs.map(async (rc) => {
          const key = rc.serverId;
          const label = rc.serverName;
          try {
            const result = await deleteOnRemote(rc);
            if (result.ok) {
              const data = result.data as { branchRetained?: RetainedBranch | null };
              results[key] = { success: true, label, targetId: rc.serverId, branchRetained: data?.branchRetained };
            } else {
              const data = result.data as { error?: string };
              results[key] = { success: false, label, targetId: rc.serverId, error: data.error || "Remote deletion failed" };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            results[key] = { success: false, label, targetId: rc.serverId, error: errorMessage };
          }
        })
      );

      const anyFailed = Object.values(results).some((r) => !r.success);
      if (anyFailed) {
        return reply.code(207).send({ success: true, results });
      }
      return reply.code(200).send({ success: true, results });
    }

    if (!hasLocal) {
      return reply.code(400).send({ error: "Project has no local path" });
    }

    // Local deletion helper
    const deleteLocal = async (): Promise<RetainedBranch | null> => {
      const { execSync, execFileSync } = await import("child_process");
      const worktreeAbsPath = resolveWorktreePath(project.path!, branch);
      const registered = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, branch, "local");
      if (registered) {
        await fastify.storage.workspaceRegistry.setCheckoutStatus(registered.checkout.id, "deleting");
      }
      let worktreeRemoved = false;

      try {
        try {
          const statusOutput = execSync("git status --porcelain", {
            cwd: worktreeAbsPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });

          if (statusOutput.trim() !== "") {
            throw new Error("Worktree has uncommitted changes. Please commit or discard changes before deleting.");
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("uncommitted changes")) throw err;
          // If git status fails for other reasons, continue with deletion attempt
        }

        await stopWorkspaceActivity(fastify, {
          projectIds: [project.id],
          branch,
          worktreePath: worktreeAbsPath,
        });

        let branchToDelete = branch;
        try {
          branchToDelete = liveWorktreeRecord(project.path!, worktreeAbsPath)?.branch ?? branch;
        } catch {
          // Fall back to the requested branch.
        }

        removeWorktreeIfPresent(execFileSync, project.path!, worktreeAbsPath);
        worktreeRemoved = true;
        invalidateWorktreeListCache(project.path!);

        const branchRetained = branchToDelete
          ? deleteBranchAfterRemoval(project.path!, branchToDelete)
          : null;
        if (registered) {
          await fastify.storage.workspaceRegistry.markCheckoutDeleted(registered.checkout.id);
        }
        return branchRetained;
      } catch (error) {
        if (registered && !worktreeRemoved) {
          // Same as the remote half: leave the checkout usable, and keep why.
          await restoreCheckoutAfterFailedDelete(
            fastify,
            registered,
            error instanceof Error ? error.message : "Local deletion failed",
          )
            .catch((registryError) => console.error("[worktree] Failed to restore local checkout status:", registryError));
        }
        throw error;
      }
    };

    // Local-only project
    if (!hasRemote) {
      try {
        const branchRetained = await deleteLocal();
        return reply.code(200).send({ success: true, branchRetained });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        if (errorMessage.includes("uncommitted changes") || error instanceof WorktreeBusyError) {
          return reply.code(409).send({ error: errorMessage });
        }
        return reply.code(500).send({ error: `Failed to delete worktree: ${errorMessage}` });
      }
    }

    // Hybrid project: delete from local + all remotes
    const results: Record<string, TargetDeleteResult> = {};

    // Delete local first
    try {
      results.local = { success: true, label: "local", targetId: "local", branchRetained: await deleteLocal() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remotes
      return reply.code(500).send({ error: `Failed to delete local worktree: ${errorMessage}` });
    }

    // Delete from all remotes in parallel
    await Promise.allSettled(
      remoteConfigs.map(async (rc) => {
        const key = remoteConfigs.length === 1 ? "remote" : rc.serverId;
        const label = rc.serverName;
        try {
          const remoteResult = await deleteOnRemote(rc);
          if (remoteResult.ok) {
            const remoteData = remoteResult.data as { branchRetained?: RetainedBranch | null };
            results[key] = { success: true, label, targetId: rc.serverId, branchRetained: remoteData?.branchRetained };
          } else {
            const remoteData = remoteResult.data as { error?: string };
            results[key] = { success: false, label, targetId: rc.serverId, error: remoteData.error || "Remote deletion failed" };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results[key] = { success: false, label, targetId: rc.serverId, error: errorMessage };
        }
      })
    );

    const anyRemoteFailed = Object.entries(results).some(([k, v]) => k !== "local" && !v.success);
    if (anyRemoteFailed) {
      return reply.code(207).send({ success: true, results });
    }

    return reply.code(200).send({ success: true, results });
  });

  // 创建新的 git worktree
  fastify.post<{
    Params: { id: string };
    // `targets` names machines: "local", a remote server id, or the legacy
    // "remote" (every linked remote at once), which older UIs still send.
    Body: { branchName: string; targets?: string[]; baseBranch?: string; remoteBaseBranch?: string };
  }>("/api/projects/:id/worktrees", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const project = await fastify.storage.projects.getById(req.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const { branchName, baseBranch, remoteBaseBranch } = req.body;

    if (!branchName || typeof branchName !== "string" || branchName.trim() === "") {
      return reply.code(400).send({ error: "Branch name is required" });
    }

    const trimmedBranch = branchName.trim();
    if (!/^[a-zA-Z0-9]/.test(trimmedBranch) || /[^a-zA-Z0-9/_-]/.test(trimmedBranch)) {
      return reply.code(400).send({ error: "Invalid branch name format" });
    }

    const localStartPoint = baseBranch?.trim() || "main";
    if (/[^a-zA-Z0-9/_.\-]/.test(localStartPoint)) {
      return reply.code(400).send({ error: "Invalid base branch name format" });
    }
    const remoteStartPoint = remoteBaseBranch?.trim() || localStartPoint;
    if (/[^a-zA-Z0-9/_.\-]/.test(remoteStartPoint)) {
      return reply.code(400).send({ error: "Invalid remote base branch name format" });
    }

    // Determine targets
    const hasLocal = !!project.path;
    const remoteConfigs = await getAllRemoteConfigs(fastify, project);
    const hasRemote = remoteConfigs.length > 0;
    const requested = (req.body.targets ?? []).map((t) => String(t).trim()).filter(Boolean);

    let wantLocal: boolean;
    let selectedRemotes: RemoteConfig[];

    if (requested.length > 0) {
      wantLocal = requested.includes("local");
      const remoteRequests = requested.filter((t) => t !== "local");
      if (remoteRequests.includes("remote")) {
        // Legacy shorthand: one checkbox standing for every linked remote.
        selectedRemotes = remoteConfigs;
      } else {
        const byId = new Map(remoteConfigs.map((rc) => [rc.serverId, rc]));
        selectedRemotes = [];
        for (const id of new Set(remoteRequests)) {
          const rc = byId.get(id);
          if (!rc) {
            return reply.code(400).send({ error: `Unknown target '${id}'` });
          }
          selectedRemotes.push(rc);
        }
      }
      if (wantLocal && !hasLocal) {
        return reply.code(400).send({ error: "Project has no local path" });
      }
      if (remoteRequests.length > 0 && !hasRemote) {
        return reply.code(400).send({ error: "Project has no remote configuration" });
      }
      if (!wantLocal && selectedRemotes.length === 0) {
        return reply.code(400).send({ error: "No target machines selected" });
      }
    } else {
      // Every machine the project has, unless the caller narrowed it. A
      // workspace that exists on only some of them is the broken state this
      // route's own partial-success reporting exists to describe, so it must
      // not be what a caller gets by saying nothing — and a caller easily says
      // nothing: linked remotes live in `project_remotes`, while the UI's
      // local+remote choice keys off the legacy `projects.remote_path`, which
      // adding a remote never sets.
      if (!hasLocal && !hasRemote) {
        return reply.code(400).send({ error: "Project has no local path" });
      }
      wantLocal = hasLocal;
      selectedRemotes = remoteConfigs;
    }

    // Helper to create worktree on a single remote
    const createOnRemote = async (rc: RemoteConfig) => {
      const previous = await fastify.storage.workspaceRegistry
        .getByProjectBranch(project.id, trimmedBranch, rc.serverId);
      const preserveReady = previous?.checkout.status === "ready";
      const pending = preserveReady && previous
        ? previous
        : await fastify.storage.workspaceRegistry.beginCheckout({
            projectId: project.id,
            branch: trimmedBranch,
            targetId: rc.serverId,
            worktreePath: conventionalWorktreePath(rc.remotePath, trimmedBranch),
            expectedBranch: trimmedBranch,
            pathSource: "conventional",
          });
      try {
        const result = await proxyToRemoteAuto(
          rc.serverId,
          "POST",
          `/api/path/worktrees`,
          { path: rc.remotePath, branchName: trimmedBranch, baseBranch: remoteStartPoint },
          { reverseConnectManager: fastify.reverseConnectManager }
        );
        if (result.ok) {
          const data = result.data as { worktree?: { worktreePath?: unknown } };
          const reportedPath = typeof data.worktree?.worktreePath === "string"
            ? data.worktree.worktreePath
            : null;
          if (reportedPath && !preserveReady) {
            await fastify.storage.workspaceRegistry.registerReadyCheckout({
              projectId: project.id,
              branch: trimmedBranch,
              targetId: rc.serverId,
              worktreePath: reportedPath,
              expectedBranch: trimmedBranch,
              pathSource: "reported",
            });
          } else {
            await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
          }
        } else if (preserveReady) {
          // A duplicate/retried create must not turn an already healthy
          // checkout into a sticky error merely because the worker rejected
          // the redundant operation.
          await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
        } else {
          const detail = result.data as { error?: string };
          await fastify.storage.workspaceRegistry.setCheckoutStatus(
            pending.checkout.id, "error", detail.error ?? result.errorCode ?? "Remote creation failed",
          );
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Remote creation failed";
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(
            pending.checkout.id,
            preserveReady ? "ready" : "error",
            preserveReady ? null : message,
          )
          .catch((registryError) => console.error("[worktree] Failed to record remote checkout error:", registryError));
        throw error;
      }
    };

    // Remote(s) only
    if (!wantLocal) {
      if (selectedRemotes.length === 1 && remoteConfigs.length === 1) {
        // Single remote: backward-compatible flat response
        const result = await createOnRemote(selectedRemotes[0]);
        return reply.code(proxyStatus(result, 201)).send(result.data);
      }

      // Multiple remotes: create on all the picked ones in parallel
      const results: Record<string, TargetCreateResult> = {};
      const settled = await Promise.allSettled(
        selectedRemotes.map(async (rc) => {
          const key = rc.serverId;
          const label = rc.serverName;
          console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}`);
          try {
            const result = await createOnRemote(rc);
            if (result.ok) {
              const data = result.data as { worktree?: { branch: string; adopted?: boolean } };
              results[key] = { success: true, label, targetId: rc.serverId, worktree: data.worktree, adopted: data.worktree?.adopted };
            } else {
              const data = result.data as { error?: string };
              console.error(`[worktree] Remote failed: serverId=${rc.serverId}, requestId=${result.requestId}, error=${JSON.stringify(result.data)}`);
              results[key] = { success: false, label, targetId: rc.serverId, error: data.error || "Remote creation failed", errorCode: result.errorCode, requestId: result.requestId };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            results[key] = { success: false, label, targetId: rc.serverId, error: errorMessage };
          }
        })
      );

      const anyFailed = Object.values(results).some((r) => !r.success);
      const allFailed = Object.values(results).every((r) => !r.success);
      if (allFailed) {
        return reply.code(500).send({ error: "Failed to create worktree on all remotes", results });
      }
      if (anyFailed) {
        return reply.code(207).send({ worktree: { branch: trimmedBranch }, results });
      }
      return reply.code(201).send({ worktree: { branch: trimmedBranch }, results });
    }

    // Local creation helper
    const createLocal = async (): Promise<{ branch: string; adopted: boolean }> => {
      // Reuses an existing branch instead of refusing it — see planWorktreeAdd.
      const plan = planWorktreeAdd(project.path!, trimmedBranch, localStartPoint);
      await assertPathIsFree(fastify, {
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: plan.worktreePath,
      });
      const pending = await fastify.storage.workspaceRegistry.beginCheckout({
        projectId: project.id,
        branch: trimmedBranch,
        targetId: "local",
        worktreePath: plan.worktreePath,
        expectedBranch: trimmedBranch,
      });

      try {
        applyWorktreeAdd(project.path!, plan);
        await fastify.storage.workspaceRegistry.setCheckoutStatus(pending.checkout.id, "ready");
        return { branch: trimmedBranch, adopted: plan.adopted };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Local creation failed";
        await fastify.storage.workspaceRegistry
          .setCheckoutStatus(pending.checkout.id, "error", message)
          .catch((registryError) => console.error("[worktree] Failed to record local checkout error:", registryError));
        throw error;
      }
    };

    // Single-target: local only (backward-compatible path)
    if (selectedRemotes.length === 0) {
      try {
        const worktree = await createLocal();
        return reply.code(201).send({ worktree });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode) return reply.code(statusCode).send({ error: errorMessage });
        if (errorMessage.includes("already exists")) {
          return reply.code(409).send({ error: errorMessage });
        }
        return reply.code(500).send({ error: `Failed to create worktree: ${errorMessage}` });
      }
    }

    // Multi-target: local + remote(s)
    const results: Record<string, TargetCreateResult> = {};

    // Local first
    let localWorktree: { branch: string; adopted: boolean } | undefined;
    try {
      localWorktree = await createLocal();
      results.local = { success: true, label: "local", targetId: "local", worktree: localWorktree, adopted: localWorktree.adopted };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Local failure: return error immediately, don't attempt remotes
      return reply.code(500).send({ error: `Failed to create local worktree: ${errorMessage}` });
    }

    // All picked remotes in parallel
    await Promise.allSettled(
      selectedRemotes.map(async (rc) => {
        const key = remoteConfigs.length === 1 ? "remote" : rc.serverId;
        const label = rc.serverName;
        console.log(`[worktree] Creating remote worktree: project=${req.params.id}, branch=${trimmedBranch}, serverId=${rc.serverId}`);
        try {
          const remoteResult = await createOnRemote(rc);
          if (remoteResult.ok) {
            const remoteData = remoteResult.data as { worktree?: { branch: string; adopted?: boolean } };
            results[key] = { success: true, label, targetId: rc.serverId, worktree: remoteData.worktree, adopted: remoteData.worktree?.adopted };
          } else {
            const remoteData = remoteResult.data as { error?: string };
            console.error(`[worktree] Remote failed: serverId=${rc.serverId}, requestId=${remoteResult.requestId}, errorCode=${remoteResult.errorCode}, status=${remoteResult.status}, duration=${remoteResult.durationMs}ms, error=${JSON.stringify(remoteResult.data)}`);
            results[key] = {
              success: false,
              label,
              targetId: rc.serverId,
              error: remoteData.error || "Remote creation failed",
              errorCode: remoteResult.errorCode,
              requestId: remoteResult.requestId,
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results[key] = { success: false, label, targetId: rc.serverId, error: errorMessage };
        }
      })
    );

    // If any remote failed, return 207 partial success
    const anyRemoteFailed = Object.entries(results).some(([k, v]) => k !== "local" && !v.success);
    if (anyRemoteFailed) {
      return reply.code(207).send({
        worktree: localWorktree,
        results,
      });
    }

    return reply.code(201).send({
      worktree: localWorktree,
      results,
    });
  });
};

export default fp(routes, { name: "worktree-routes" });
