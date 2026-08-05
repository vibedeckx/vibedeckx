import crypto from "crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { DB, WorkspacesTable, WorkspaceCheckoutsTable } from "../schema.js";
import type { DialectHelpers } from "../dialect.js";
import type {
  RegisteredWorkspaceCheckout,
  Storage,
  WorkspaceCheckoutRecord,
  WorkspaceCheckoutStatus,
  WorkspaceRecord,
  WorkspaceStatus,
} from "../types.js";

const mapWorkspace = (row: Selectable<WorkspacesTable>): WorkspaceRecord => ({
  id: row.id,
  project_id: row.project_id,
  branch: row.branch,
  status: row.status as WorkspaceStatus,
  error: row.error,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const mapCheckout = (row: Selectable<WorkspaceCheckoutsTable>): WorkspaceCheckoutRecord => ({
  id: row.id,
  workspace_id: row.workspace_id,
  target_id: row.target_id,
  worktree_path: row.worktree_path,
  expected_branch: row.expected_branch,
  status: row.status as WorkspaceCheckoutStatus,
  error: row.error,
  deleted_at: row.deleted_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

type DbExecutor = Kysely<DB> | Transaction<DB>;

async function recomputeWorkspace(
  db: DbExecutor,
  workspaceId: string,
  h: DialectHelpers,
): Promise<void> {
  const rows = await db.selectFrom("workspace_checkouts")
    .select(["status", "error"])
    .where("workspace_id", "=", workspaceId)
    .where("deleted_at", "is", null)
    .execute();
  if (rows.length === 0) {
    await db.updateTable("workspaces")
      .set({ status: "archived", error: null, updated_at: h.nowMs() })
      .where("id", "=", workspaceId)
      .execute();
    return;
  }
  const statuses = new Set(rows.map((row) => row.status));
  const status: WorkspaceCheckoutStatus = statuses.has("ready")
    ? "ready"
    : statuses.has("creating")
      ? "creating"
      : statuses.has("deleting")
        ? "deleting"
        : "error";
  const error = status === "error"
    ? rows.map((row) => row.error).find((value): value is string => Boolean(value)) ?? "Checkout failed"
    : null;
  await db.updateTable("workspaces")
    .set({ status, error, updated_at: h.nowMs() })
    .where("id", "=", workspaceId)
    .execute();
}

async function upsertCheckout(
  trx: Transaction<DB>,
  h: DialectHelpers,
  opts: {
    projectId: string;
    branch: string;
    targetId: string;
    worktreePath: string;
    expectedBranch: string;
    status: WorkspaceCheckoutStatus;
  },
): Promise<RegisteredWorkspaceCheckout> {
  const now = h.nowMs();
  let workspaceRow = await trx.selectFrom("workspaces")
    .selectAll()
    .where("project_id", "=", opts.projectId)
    .where("branch", "=", opts.branch)
    .executeTakeFirst();
  if (!workspaceRow) {
    const workspaceId = crypto.randomUUID();
    await trx.insertInto("workspaces").values({
      id: workspaceId,
      project_id: opts.projectId,
      branch: opts.branch,
      status: opts.status,
      error: null,
      created_at: now,
      updated_at: now,
    }).execute();
    workspaceRow = await trx.selectFrom("workspaces").selectAll().where("id", "=", workspaceId).executeTakeFirstOrThrow();
  }

  const activeCheckout = await trx.selectFrom("workspace_checkouts")
    .select("id")
    .where("workspace_id", "=", workspaceRow.id)
    .where("target_id", "=", opts.targetId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const checkoutId = activeCheckout?.id ?? crypto.randomUUID();
  if (activeCheckout) {
    await trx.updateTable("workspace_checkouts").set({
      worktree_path: opts.worktreePath,
      expected_branch: opts.expectedBranch,
      status: opts.status,
      error: null,
      updated_at: now,
    }).where("id", "=", checkoutId).execute();
  } else {
    await trx.insertInto("workspace_checkouts").values({
      id: checkoutId,
      workspace_id: workspaceRow.id,
      target_id: opts.targetId,
      worktree_path: opts.worktreePath,
      expected_branch: opts.expectedBranch,
      status: opts.status,
      error: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }).execute();
  }

  await recomputeWorkspace(trx, workspaceRow.id, h);
  const [workspace, checkout] = await Promise.all([
    trx.selectFrom("workspaces").selectAll().where("id", "=", workspaceRow.id).executeTakeFirstOrThrow(),
    trx.selectFrom("workspace_checkouts").selectAll()
      .where("id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
  ]);
  return { workspace: mapWorkspace(workspace), checkout: mapCheckout(checkout) };
}

export const createWorkspaceRegistryRepo = (
  kdb: Kysely<DB>,
  h: DialectHelpers,
): Pick<Storage, "workspaceRegistry"> => ({
  workspaceRegistry: {
    beginCheckout: (opts) => kdb.transaction().execute((trx) =>
      upsertCheckout(trx, h, { ...opts, status: "creating" })),

    registerReadyCheckout: (opts) => kdb.transaction().execute((trx) =>
      upsertCheckout(trx, h, { ...opts, status: "ready" })),

    setCheckoutStatus: async (checkoutId, status, error = null) => {
      await kdb.transaction().execute(async (trx) => {
        const checkout = await trx.selectFrom("workspace_checkouts")
          .select("workspace_id")
          .where("id", "=", checkoutId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (!checkout) return;
        await trx.updateTable("workspace_checkouts")
          .set({ status, error, updated_at: h.nowMs() })
          .where("id", "=", checkoutId)
          .where("deleted_at", "is", null)
          .execute();
        await recomputeWorkspace(trx, checkout.workspace_id, h);
      });
    },

    setCheckoutStatusIfCurrent: async (
      checkoutId,
      expected,
      status,
      error = null,
    ) => kdb.transaction().execute(async (trx) => {
      const result = await trx.updateTable("workspace_checkouts")
        .set({ status, error, updated_at: h.nowMs() })
        .where("id", "=", checkoutId)
        .where("deleted_at", "is", null)
        .where("status", "=", expected.status)
        .where("updated_at", "=", expected.updatedAt)
        .executeTakeFirst();
      const changed = result.numUpdatedRows > 0n;
      if (changed) {
        const checkout = await trx.selectFrom("workspace_checkouts")
          .select("workspace_id").where("id", "=", checkoutId).executeTakeFirstOrThrow();
        await recomputeWorkspace(trx, checkout.workspace_id, h);
      }
      return changed;
    }),

    listByProject: async (projectId, targetId, opts) => {
      let query = kdb.selectFrom("workspaces as workspace")
        .innerJoin("workspace_checkouts as checkout", "checkout.workspace_id", "workspace.id")
        .selectAll("workspace")
        .select([
          "checkout.id as checkout_id",
          "checkout.workspace_id as checkout_workspace_id",
          "checkout.target_id as checkout_target_id",
          "checkout.worktree_path as checkout_worktree_path",
          "checkout.expected_branch as checkout_expected_branch",
          "checkout.status as checkout_status",
          "checkout.error as checkout_error",
          "checkout.deleted_at as checkout_deleted_at",
          "checkout.created_at as checkout_created_at",
          "checkout.updated_at as checkout_updated_at",
        ])
        .where("workspace.project_id", "=", projectId);
      if (targetId) query = query.where("checkout.target_id", "=", targetId);
      if (!opts?.includeDeleted) query = query.where("checkout.deleted_at", "is", null);
      const rows = await query.orderBy("workspace.created_at", "asc").execute();
      return rows.map((row) => ({
        workspace: mapWorkspace(row),
        checkout: {
          id: row.checkout_id,
          workspace_id: row.checkout_workspace_id,
          target_id: row.checkout_target_id,
          worktree_path: row.checkout_worktree_path,
          expected_branch: row.checkout_expected_branch,
          status: row.checkout_status as WorkspaceCheckoutStatus,
          error: row.checkout_error,
          deleted_at: row.checkout_deleted_at,
          created_at: row.checkout_created_at,
          updated_at: row.checkout_updated_at,
        },
      }));
    },

    getCheckoutById: async (checkoutId) => {
      const checkout = await kdb.selectFrom("workspace_checkouts")
        .selectAll().where("id", "=", checkoutId).executeTakeFirst();
      if (!checkout) return undefined;
      const workspace = await kdb.selectFrom("workspaces")
        .selectAll().where("id", "=", checkout.workspace_id).executeTakeFirstOrThrow();
      return { workspace: mapWorkspace(workspace), checkout: mapCheckout(checkout) };
    },

    getByProjectBranch: async (projectId, branch, targetId) => {
      const rows = await kdb.selectFrom("workspaces as workspace")
        .innerJoin("workspace_checkouts as checkout", "checkout.workspace_id", "workspace.id")
        .selectAll("workspace")
        .select([
          "checkout.id as checkout_id", "checkout.workspace_id as checkout_workspace_id",
          "checkout.target_id as checkout_target_id", "checkout.worktree_path as checkout_worktree_path",
          "checkout.expected_branch as checkout_expected_branch", "checkout.status as checkout_status",
          "checkout.error as checkout_error", "checkout.created_at as checkout_created_at",
          "checkout.updated_at as checkout_updated_at", "checkout.deleted_at as checkout_deleted_at",
        ])
        .where("workspace.project_id", "=", projectId)
        .where("workspace.branch", "=", branch)
        .where("checkout.target_id", "=", targetId)
        .where("checkout.deleted_at", "is", null)
        .executeTakeFirst();
      if (!rows) return undefined;
      return {
        workspace: mapWorkspace(rows),
        checkout: {
          id: rows.checkout_id, workspace_id: rows.checkout_workspace_id,
          target_id: rows.checkout_target_id, worktree_path: rows.checkout_worktree_path,
          expected_branch: rows.checkout_expected_branch,
          status: rows.checkout_status as WorkspaceCheckoutStatus, error: rows.checkout_error,
          deleted_at: rows.checkout_deleted_at,
          created_at: rows.checkout_created_at, updated_at: rows.checkout_updated_at,
        },
      };
    },

    markCheckoutDeleted: async (checkoutId) => {
      await kdb.transaction().execute(async (trx) => {
        const checkout = await trx.selectFrom("workspace_checkouts")
          .select(["workspace_id", "deleted_at"])
          .where("id", "=", checkoutId)
          .executeTakeFirst();
        if (!checkout || checkout.deleted_at !== null) return;
        await trx.updateTable("workspace_checkouts")
          .set({ deleted_at: h.nowMs(), updated_at: h.nowMs() })
          .where("id", "=", checkoutId)
          .where("deleted_at", "is", null)
          .execute();
        await recomputeWorkspace(trx, checkout.workspace_id, h);
      });
    },
  },
});
