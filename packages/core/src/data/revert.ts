import type { ChangeSet, FileChange, FileRecord } from "../types/entities.js";
import type { Uuid } from "../types/ids.js";
import { deriveFileMeta } from "../sync/derive.js";
import { sha256Hex } from "../utils/hash.js";
import type { ChangeSetRepo, FileRepo } from "./repositories.js";

export interface RevertChangeSetDeps {
  files: FileRepo;
  changeSets: ChangeSetRepo;
  /** Auth user attributed with the revert, or null for system/local use. */
  authorId: Uuid | null;
  newId: () => string;
  now: () => string;
}

export interface RevertedFile {
  fileId: string;
  path: string;
  beforeVersion: number;
  afterVersion: number | null;
  op: FileChange["op"];
}

export type RevertChangeSetResult =
  | {
      status: "reverted";
      changeSetId: string;
      revertChangeSetId: string;
      files: RevertedFile[];
    }
  | {
      status: "already_reverted";
      changeSetId: string;
      revertChangeSetId: null;
      files: [];
    };

export class RevertChangeSetError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "already_changed"
      | "missing_file"
      | "missing_version"
      | "empty_change_set"
      | "commit_conflict",
  ) {
    super(message);
    this.name = "RevertChangeSetError";
  }
}

/**
 * Apply the inverse of one agent change-set.
 *
 * Guardrail: every touched file must still be exactly at the version produced
 * by the change-set. If a human or another agent changed any touched file after
 * that, the revert refuses rather than overwriting later work.
 */
export async function revertChangeSet(
  changeSetId: string,
  deps: RevertChangeSetDeps,
): Promise<RevertChangeSetResult> {
  const changeSet = await deps.changeSets.get(changeSetId);
  if (!changeSet) {
    throw new RevertChangeSetError(`change-set ${changeSetId} was not found`, "not_found");
  }
  if (changeSet.reverted) {
    return {
      status: "already_reverted",
      changeSetId,
      revertChangeSetId: null,
      files: [],
    };
  }

  const changes = orderForRevert(await deps.changeSets.listChanges(changeSetId));
  if (changes.length === 0) {
    throw new RevertChangeSetError(
      `change-set ${changeSetId} has no file changes`,
      "empty_change_set",
    );
  }

  const planned = await Promise.all(changes.map((change) => planInverse(changeSet, change, deps)));

  const revertId = deps.newId();
  const now = deps.now();
  await deps.changeSets.create(
    {
      id: revertId,
      workspaceId: changeSet.workspaceId,
      kind: "manual",
      summary: `Reverted: ${changeSet.summary || changeSet.kind}`,
      sourceEvent: { revertsChangeSetId: changeSet.id },
      authorId: deps.authorId,
      createdAt: now,
      reverted: false,
    },
    [],
  );

  const files: RevertedFile[] = [];
  const inverseChanges: FileChange[] = [];
  for (const plan of planned) {
    const committed = await deps.files.commit(plan.next, {
      versionId: deps.newId(),
      expectedVersion: plan.expectedVersion,
      authorId: deps.authorId,
      changeSetId: revertId,
    });
    if (committed.status !== "committed") {
      throw new RevertChangeSetError(
        `revert lost the commit race for ${plan.current.path}`,
        "commit_conflict",
      );
    }
    files.push({
      fileId: committed.file.id,
      path: committed.file.path,
      beforeVersion: plan.expectedVersion,
      afterVersion: plan.inverse.afterVersion,
      op: plan.inverse.op,
    });
    inverseChanges.push({
      id: deps.newId(),
      changeSetId: revertId,
      fileId: committed.file.id,
      op: plan.inverse.op,
      beforeVersion: plan.expectedVersion,
      afterVersion: plan.inverse.afterVersion,
      diff: "",
    });
  }

  await deps.changeSets.addChanges(inverseChanges);
  await deps.changeSets.markReverted(changeSetId);

  return {
    status: "reverted",
    changeSetId,
    revertChangeSetId: revertId,
    files,
  };
}

function orderForRevert(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => appliedVersionOf(b) - appliedVersionOf(a));
}

function appliedVersionOf(change: FileChange): number {
  if (change.afterVersion !== null) return change.afterVersion;
  if (change.beforeVersion !== null) return change.beforeVersion + 1;
  return 0;
}

interface InversePlan {
  current: FileRecord;
  expectedVersion: number;
  next: FileRecord;
  inverse: Pick<FileChange, "op" | "afterVersion">;
}

async function planInverse(
  changeSet: ChangeSet,
  change: FileChange,
  deps: RevertChangeSetDeps,
): Promise<InversePlan> {
  const current = await deps.files.get(change.fileId);
  if (!current) {
    throw new RevertChangeSetError(
      `file ${change.fileId} from change-set ${changeSet.id} was not found`,
      "missing_file",
    );
  }
  if (current.workspaceId !== changeSet.workspaceId) {
    throw new RevertChangeSetError(
      `file ${change.fileId} is no longer in workspace ${changeSet.workspaceId}`,
      "missing_file",
    );
  }

  const expectedVersion = appliedVersionOf(change);
  if (current.version !== expectedVersion) {
    throw new RevertChangeSetError(
      `${current.path} is at v${current.version}; revert expected v${expectedVersion}`,
      "already_changed",
    );
  }

  switch (change.op) {
    case "create":
      return planCreatedFileDeletion(current, expectedVersion, deps);
    case "update":
      return planRestorePreviousVersion(change, current, expectedVersion, deps);
    case "delete":
      if (!current.deleted) {
        throw new RevertChangeSetError(
          `${current.path} is no longer deleted; refusing to restore over later work`,
          "already_changed",
        );
      }
      return planRestorePreviousVersion(change, current, expectedVersion, deps);
  }
}

async function planCreatedFileDeletion(
  current: FileRecord,
  expectedVersion: number,
  deps: RevertChangeSetDeps,
): Promise<InversePlan> {
  if (current.deleted) {
    throw new RevertChangeSetError(
      `${current.path} is already deleted; refusing to revert a stale create`,
      "already_changed",
    );
  }
  return {
    current,
    expectedVersion,
    next: {
      ...current,
      version: current.version + 1,
      updatedBy: "human",
      updatedAt: deps.now(),
      deleted: true,
    },
    inverse: { op: "delete", afterVersion: null },
  };
}

async function planRestorePreviousVersion(
  change: FileChange,
  current: FileRecord,
  expectedVersion: number,
  deps: RevertChangeSetDeps,
): Promise<InversePlan> {
  if (change.beforeVersion === null) {
    throw new RevertChangeSetError(
      `change ${change.id} has no before_version to restore`,
      "missing_version",
    );
  }
  const before = await deps.files.getVersion(change.fileId, change.beforeVersion);
  if (!before) {
    throw new RevertChangeSetError(
      `file ${change.fileId} is missing historical version ${change.beforeVersion}`,
      "missing_version",
    );
  }
  const meta = deriveFileMeta(current.path, before.content);
  const nextVersion = current.version + 1;
  return {
    current,
    expectedVersion,
    next: {
      ...current,
      ...meta,
      content: before.content,
      sha256: await sha256Hex(before.content),
      version: nextVersion,
      updatedBy: "human",
      updatedAt: deps.now(),
      deleted: false,
    },
    inverse: { op: "update", afterVersion: nextVersion },
  };
}
