// Pure logic for the binary-asset sync pass (images embedded in notes).
// main/sync.ts executes the plan against Supabase Storage + the assets table;
// everything here is deterministic and unit-tested. Mirrors the markdown
// engine's philosophy (packages/core/src/sync/engine.ts) at file granularity:
// no 3-way merge for binaries — a genuine both-sides change keeps the remote
// copy canonical and saves the local bytes as a `*.conflict.*` sibling.

/** Content fingerprints per vault-relative path. */
export type ShaMap = Record<string, string>;

export interface AssetPlan {
  /** Local bytes win: upload to storage + upsert the assets row. */
  upload: string[];
  /** Remote bytes win: download from storage into the vault. */
  download: string[];
  /** Deleted locally since last sync: remove the storage object + row. */
  deleteRemote: string[];
  /** Deleted remotely since last sync: remove the local file. */
  deleteLocal: string[];
  /** Changed on both sides: keep remote at `path`, save local as `conflictPath`. */
  conflicts: { path: string; conflictPath: string }[];
}

/**
 * Reconcile local asset files against the remote assets table, through the
 * last-synced state (the common ancestor). All three maps are path -> sha256.
 *
 *   * new on one side only        -> copy to the other side
 *   * changed on one side only    -> propagate that change
 *   * changed on both sides       -> remote (first-committed) wins; the local
 *                                    bytes become a conflict copy, which then
 *                                    uploads as its own new asset
 *   * deleted on one side         -> delete on the other (state remembers it
 *                                    existed, so a delete is distinguishable
 *                                    from "never synced")
 *   * deleted on both             -> forget it
 */
export function planAssetSync(local: ShaMap, remote: ShaMap, state: ShaMap): AssetPlan {
  const plan: AssetPlan = {
    upload: [],
    download: [],
    deleteRemote: [],
    deleteLocal: [],
    conflicts: [],
  };
  const paths = new Set([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(state),
  ]);
  const taken = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const path of [...paths].sort()) {
    const loc = local[path];
    const rem = remote[path];
    const base = state[path];

    if (loc !== undefined && rem === undefined) {
      if (base === undefined) plan.upload.push(path); // new local file
      else if (loc === base) plan.deleteLocal.push(path); // deleted remotely
      else plan.upload.push(path); // edited locally while deleted remotely — edits win
      continue;
    }
    if (loc === undefined && rem !== undefined) {
      if (base === undefined) plan.download.push(path); // new remote file
      else if (rem === base) plan.deleteRemote.push(path); // deleted locally
      else plan.download.push(path); // edited remotely while deleted locally — edits win
      continue;
    }
    if (loc === undefined || rem === undefined) continue; // gone on both sides

    if (loc === rem) continue; // in sync (state catches up in the caller)
    const localChanged = loc !== base;
    const remoteChanged = rem !== base;
    if (localChanged && !remoteChanged) {
      plan.upload.push(path);
    } else if (!localChanged && remoteChanged) {
      plan.download.push(path);
    } else {
      // Both changed: remote stays canonical, local bytes survive as a copy.
      plan.conflicts.push({ path, conflictPath: mintConflictPath(path, taken) });
    }
  }
  return plan;
}

/** `pic.png` -> `pic.conflict.png` (then `pic.conflict 2.png`, …). */
function mintConflictPath(path: string, taken: Set<string>): string {
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let candidate = `${stem}.conflict${ext}`;
  for (let i = 2; taken.has(candidate); i++) {
    candidate = `${stem}.conflict ${i}${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Content type for an asset path (upload metadata + data: URLs). */
export function assetMime(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
