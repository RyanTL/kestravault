import { app, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  createSupabaseClient,
  emptySyncState,
  mintPublicToken,
  syncVault,
  ulid,
  SupabaseEntitlementRepo,
  SupabaseChangeSetRepo,
  SupabaseFileRepo,
  SupabaseMembershipRepo,
  SupabasePrivacyRuleRepo,
  SupabaseWorkspaceRepo,
  revertChangeSet,
  RevertChangeSetError,
  isCloudPrivacyMode,
  normalizePrivacyPath,
  privacyRuleKey,
  resolveEffectivePrivacy,
  shouldSyncPrivacyMode,
  type KestravaultSupabaseClient,
  type LocalVaultStore,
  type PrivacyRule,
  type PrivacyRuleRecord,
  type PrivacyTarget,
  type SyncState,
} from "@kestravault/core";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import { WebSocket as NodeWebSocket } from "ws";
import { createHash } from "node:crypto";
import {
  readTree,
  readFile,
  readPrivacyRules,
  readLocalPrivacyStore,
  writeLocalPrivacyStore,
  writeFile,
  deleteEntry,
  listAssetFiles,
  readBinaryRaw,
  writeBinaryRaw,
  type VaultNode,
} from "./vault.js";
import { assetMime, planAssetSync, type ShaMap } from "./assets.js";
import { HOSTED_SUPABASE_URL, HOSTED_SUPABASE_ANON_KEY } from "./hosted.js";
import { getSecret, setSecret } from "./secrets.js";
import { SYNC_SERVER_SECRET_ID } from "./syncServer.js";

// ── Sync service ─────────────────────────────────────────────────────────────
// Cloud sync + shared workspaces for the desktop app. The heavy logic lives in
// @kestravault/core (sync engine, repos); this module owns the Electron glue:
//
//   * server config    — the hosted KestraVault Cloud (baked in via env at build
//                        time) or a SELF-HOSTED Supabase instance the user
//                        points the app at (URL + anon key). Open-core: same
//                        code either way (plan/sync-collab-open-core.md §4).
//   * account          — Supabase email+password auth; the session's refresh
//                        token is encrypted at rest via secrets.ts (OS keychain).
//   * vault link       — a vault syncs when linked to a workspace; the link and
//                        the engine's SyncState live under the vault's .kestravault/
//                        folder (ignored by the file tree and the sync walker).
//   * the loop         — sync on launch, on local file changes (debounced), on
//                        Supabase Realtime pushes, and on a slow interval.
//
// AI stays out of this file on purpose: every member brings their own key /
// Claude login (ai.ts) — sync moves markdown, never model traffic.

const SESSION_SECRET_ID = "supabase.session";
const LINK_FILE = ".kestravault/sync.json";
const STATE_FILE = ".kestravault/sync-state.json";
const ASSET_STATE_FILE = ".kestravault/asset-state.json";
const ASSET_BUCKET = "vault-assets";
const SYNC_INTERVAL_MS = 120_000;
const LOCAL_DEBOUNCE_MS = 2_000;
const REMOTE_DEBOUNCE_MS = 1_500;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types shared with the renderer (mirrored in preload/index.ts) ────────────

export type SyncMode = "hosted" | "self-hosted";

export interface SyncConfigInfo {
  mode: SyncMode;
  /** Whether this build ships a hosted KestraVault Cloud endpoint. */
  hostedAvailable: boolean;
  /** Self-host fields (URL is shown back; the key is write-only). */
  selfHostUrl: string;
  hasSelfHostKey: boolean;
  /** True when a usable server (hosted or self-host) is configured. */
  configured: boolean;
}

export interface SyncAccount {
  userId: string;
  email: string | null;
  /** Server-truth "may create/share cloud vaults" (self-host always true). */
  hasActivePlan: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface MemberSummary {
  userId: string;
  role: "owner" | "member";
  createdAt: string;
  isSelf: boolean;
  /** Account email, resolved via the member-directory RPC (null on servers
   *  without that migration — the UI falls back to a truncated id). */
  email: string | null;
}

/** One row of the attributed change feed, ready for the renderer. */
export interface FeedEntry {
  versionId: string;
  path: string;
  title: string;
  version: number;
  /** "human" | "agent" — agent writes have no author email. */
  updatedBy: string;
  authorEmail: string | null;
  isSelf: boolean;
  deleted: boolean;
  createdAt: string;
}

/** One agent change-set that can be inspected/reverted from Activity. */
export interface AgentChangeSetSummary {
  id: string;
  kind: string;
  summary: string;
  authorId: string | null;
  createdAt: string;
  reverted: boolean;
  fileCount: number;
  paths: string[];
}

export interface RevertAgentChangeSetResult {
  status: "reverted" | "already_reverted";
  changeSetId: string;
  revertChangeSetId: string | null;
  fileCount: number;
}

/** One person currently connected to the linked workspace (Realtime presence). */
export interface PresenceEntry {
  userId: string;
  email: string | null;
  /** The note they're editing right now, or null when idle/browsing. */
  notePath: string | null;
  noteTitle: string | null;
  isSelf: boolean;
}

export interface SyncStatusInfo {
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  lastSummary: string | null;
  /** Paths that hit first-committer-wins conflicts in the last run. */
  conflicts: string[];
}

// ── Server configuration ─────────────────────────────────────────────────────

interface StoredSyncSettings {
  mode: SyncMode;
  selfHostUrl: string;
}

let settings: StoredSyncSettings | null = null;

function settingsFile(): string {
  return join(app.getPath("userData"), "sync-settings.json");
}

async function loadSettings(): Promise<StoredSyncSettings> {
  if (settings) return settings;
  try {
    const raw = await fs.readFile(settingsFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSyncSettings>;
    settings = {
      mode: parsed.mode === "self-hosted" ? "self-hosted" : "hosted",
      selfHostUrl: typeof parsed.selfHostUrl === "string" ? parsed.selfHostUrl : "",
    };
  } catch {
    settings = { mode: "hosted", selfHostUrl: "" };
  }
  return settings;
}

async function saveSettings(next: StoredSyncSettings): Promise<void> {
  settings = next;
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), "utf8");
}

// The hosted endpoint is baked into the build (hosted.ts — the anon key is a
// PUBLIC key by design; RLS is the security boundary) so downloaded apps sync
// out of the box. Env vars override it for dev/staging/forks. Self-hosters
// don't need any of this.
function hostedConfig(): { url: string; key: string } | null {
  const url = process.env["KESTRAVAULT_SUPABASE_URL"] || HOSTED_SUPABASE_URL;
  const key = process.env["KESTRAVAULT_SUPABASE_ANON_KEY"] || HOSTED_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

async function activeServer(): Promise<{ url: string; key: string } | null> {
  const s = await loadSettings();
  if (s.mode === "self-hosted") {
    // Same secret id as the "Test connection" probe (syncServer.ts), so the
    // probe verifies the exact anon key the real client will use.
    const key = getSecret(SYNC_SERVER_SECRET_ID);
    return s.selfHostUrl && key ? { url: s.selfHostUrl, key } : null;
  }
  return hostedConfig();
}

// ── Client + session ─────────────────────────────────────────────────────────

let client: KestravaultSupabaseClient | null = null;
let clientServerUrl = "";

async function getClient(): Promise<KestravaultSupabaseClient | null> {
  const server = await activeServer();
  if (!server) {
    client = null;
    return null;
  }
  if (!client || clientServerUrl !== server.url) {
    // Electron's main process runs on Node < 22, which has no global
    // `WebSocket`, so hand Supabase Realtime the `ws` implementation.
    client = createSupabaseClient({ ...server, transport: NodeWebSocket });
    clientServerUrl = server.url;
    sessionRestored = false;
  }
  return client;
}

interface StoredSession {
  access_token: string;
  refresh_token: string;
}

let sessionRestored = false;

async function persistSession(session: Session | null): Promise<void> {
  const value = session
    ? JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      } satisfies StoredSession)
    : "";
  await setSecret(SESSION_SECRET_ID, value);
}

/** Restore (and if needed refresh) the persisted session on this client. */
async function ensureSession(): Promise<Session | null> {
  const c = await getClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  if (data.session) return data.session;
  if (sessionRestored) return null;
  sessionRestored = true;
  const raw = getSecret(SESSION_SECRET_ID);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    const { data: restored, error } = await c.auth.setSession(stored);
    if (error || !restored.session) return null;
    await persistSession(restored.session); // tokens rotate on refresh
    return restored.session;
  } catch {
    return null;
  }
}

// ── Vault link + engine state (.kestravault/ in the vault) ──────────────────────

interface VaultLink {
  workspaceId: string;
  workspaceName: string;
}

async function readVaultJson<T>(relPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(relPath)) as T;
  } catch {
    return null;
  }
}

const readLink = (): Promise<VaultLink | null> => readVaultJson<VaultLink>(LINK_FILE);
const readState = (): Promise<SyncState | null> => readVaultJson<SyncState>(STATE_FILE);

async function writeVaultJson(relPath: string, value: unknown): Promise<void> {
  await writeFile(relPath, JSON.stringify(value, null, 2));
}

// The engine's view of the vault folder: every .md file the tree walker shows
// (dotfolders like .kestravault are already excluded), via the path-safe vault fs.
const fsLocalStore: LocalVaultStore = {
  async list() {
    const privacyRules = await readPrivacyRules();
    const paths: string[] = [];
    const walk = (nodes: VaultNode[]): void => {
      for (const node of nodes) {
        if (node.kind === "file") paths.push(node.path);
        else walk(node.children);
      }
    };
    walk(await readTree());
    const syncable = paths.filter((path) =>
      shouldSyncPrivacyMode(resolveEffectivePrivacy(path, "file", privacyRules).mode),
    );
    return Promise.all(syncable.map(async (path) => ({ path, content: await readFile(path) })));
  },
  write: (path, content) => writeFile(path, content),
  remove: (path) => deleteEntry(path),
};

// ── Status + notifications ───────────────────────────────────────────────────

let syncing = false;
let queued = false;
let lastSyncAt: number | null = null;
let lastError: string | null = null;
let lastSummary: string | null = null;
let lastConflicts: string[] = [];

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export async function syncStatus(): Promise<SyncStatusInfo> {
  const server = await activeServer();
  const session = server ? await ensureSession() : null;
  const link = await readLink();
  return {
    configured: server !== null,
    signedIn: session !== null,
    email: session?.user.email ?? null,
    workspaceId: link?.workspaceId ?? null,
    workspaceName: link?.workspaceName ?? null,
    syncing,
    lastSyncAt,
    lastError,
    lastSummary,
    conflicts: lastConflicts,
  };
}

async function notifyStatus(): Promise<void> {
  broadcast("sync:status-changed", await syncStatus());
}

function privacyKey(path: string, target: PrivacyTarget): string {
  return privacyRuleKey(normalizePrivacyPath(path), target);
}

function newer(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").localeCompare(b ?? "") > 0;
}

function samePrivacyJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function syncPrivacyRules(
  c: KestravaultSupabaseClient,
  workspaceId: string,
  authorId: string,
): Promise<{ changedLocal: boolean; touchedRemote: number }> {
  const repo = new SupabasePrivacyRuleRepo(c);
  const remote = await repo.list(workspaceId, { includeDeleted: true });
  const store = await readLocalPrivacyStore();
  const before = JSON.parse(JSON.stringify(store)) as typeof store;

  const remoteByKey = new Map(remote.map((r) => [privacyKey(r.path, r.target), r]));
  const localCloudByKey = new Map(
    store.rules
      .filter((r) => isCloudPrivacyMode(r.mode))
      .map((r) => [privacyKey(r.path, r.target), r]),
  );
  const localOnlyByKey = new Map(
    store.rules
      .filter((r) => r.mode === "local-only")
      .map((r) => [privacyKey(r.path, r.target), r]),
  );
  const tombstoneByKey = new Map(
    store.tombstones.map((t) => [privacyKey(t.path, t.target), t]),
  );

  const keys = new Set([
    ...remoteByKey.keys(),
    ...localCloudByKey.keys(),
    ...localOnlyByKey.keys(),
    ...tombstoneByKey.keys(),
  ]);

  let touchedRemote = 0;
  const upsertRemote = async (record: PrivacyRuleRecord): Promise<void> => {
    await repo.upsert(record);
    touchedRemote++;
  };

  for (const key of keys) {
    const remoteRule = remoteByKey.get(key);
    const localCloud = localCloudByKey.get(key);
    const localOnly = localOnlyByKey.get(key);
    const tombstone = tombstoneByKey.get(key);
    const localDeleteAt = newer(localOnly?.updatedAt, tombstone?.updatedAt)
      ? localOnly?.updatedAt
      : tombstone?.updatedAt;
    const newestAt = [remoteRule?.updatedAt, localCloud?.updatedAt, localDeleteAt]
      .filter(Boolean)
      .sort((a, b) => b!.localeCompare(a!))[0];

    if (localCloud && localCloud.updatedAt === newestAt) {
      if (
        !remoteRule ||
        remoteRule.deleted ||
        remoteRule.mode !== localCloud.mode ||
        remoteRule.updatedAt !== localCloud.updatedAt
      ) {
        await upsertRemote({
          workspaceId,
          path: normalizePrivacyPath(localCloud.path),
          target: localCloud.target,
          mode: localCloud.mode,
          updatedBy: authorId,
          updatedAt: localCloud.updatedAt,
          deleted: false,
          source: "cloud",
        });
      }
      store.tombstones = store.tombstones.filter((t) => privacyKey(t.path, t.target) !== key);
      continue;
    }

    if (localDeleteAt && localDeleteAt === newestAt) {
      if (!remoteRule || !remoteRule.deleted || newer(localDeleteAt, remoteRule.updatedAt)) {
        const [target, ...pathParts] = key.split(":");
        await upsertRemote({
          workspaceId,
          target: target as PrivacyTarget,
          path: pathParts.join(":"),
          mode: "public",
          updatedBy: authorId,
          updatedAt: localDeleteAt,
          deleted: true,
          source: "cloud",
        });
      }
      store.rules = store.rules.filter((r) =>
        r.mode === "local-only" ? true : privacyKey(r.path, r.target) !== key,
      );
      continue;
    }

    if (!remoteRule || remoteRule.updatedAt !== newestAt) continue;

    if (remoteRule.deleted) {
      store.rules = store.rules.filter((r) =>
        r.mode === "local-only" ? true : privacyKey(r.path, r.target) !== key,
      );
      store.tombstones = store.tombstones.filter((t) => privacyKey(t.path, t.target) !== key);
    } else {
      store.rules = [
        ...store.rules.filter((r) => privacyKey(r.path, r.target) !== key),
        {
          path: normalizePrivacyPath(remoteRule.path),
          target: remoteRule.target,
          mode: remoteRule.mode,
          updatedAt: remoteRule.updatedAt,
          source: "cloud",
        },
      ];
      store.tombstones = store.tombstones.filter((t) => privacyKey(t.path, t.target) !== key);
    }
  }

  const changedLocal = !samePrivacyJson(before, store);
  if (changedLocal) await writeLocalPrivacyStore(store);
  return { changedLocal, touchedRemote };
}

// ── The sync loop ─────────────────────────────────────────────────────────────

export async function syncNow(): Promise<SyncStatusInfo> {
  if (syncing) {
    queued = true;
    return syncStatus();
  }
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  const link = await readLink();
  if (!c || !session || !link) return syncStatus();

  syncing = true;
  void notifyStatus();
  try {
    const privacy = await syncPrivacyRules(c, link.workspaceId, session.user.id);
    const privacyRules = await readPrivacyRules();
    const state = (await readState()) ?? emptySyncState(link.workspaceId);
    if (state.workspaceId !== link.workspaceId) {
      // The vault was re-linked; old state belongs to the previous workspace.
      state.workspaceId = link.workspaceId;
      state.files = {};
    }
    const report = await syncVault(state, {
      files: new SupabaseFileRepo(c),
      local: fsLocalStore,
      authorId: session.user.id,
      shouldSyncPath: (path) =>
        shouldSyncPrivacyMode(resolveEffectivePrivacy(path, "file", privacyRules).mode),
    });
    await writeVaultJson(STATE_FILE, report.state);

    // Binary assets ride along after the markdown pass; their failure must
    // never take down note sync (storage may be missing on older self-hosts).
    let assets: AssetSyncOutcome | null = null;
    let assetError: string | null = null;
    try {
      assets = await syncAssets(c, link.workspaceId, privacyRules);
    } catch (error) {
      assetError = error instanceof Error ? error.message : String(error);
    }

    lastSyncAt = Date.now();
    lastConflicts = [
      ...report.conflicts.map((conflict) => conflict.path),
      ...(assets?.conflicts ?? []),
    ];
    lastError = report.errors.length
      ? `${report.errors.length} file(s) failed: ${report.errors[0]?.message ?? ""}`
      : assetError
        ? `assets: ${assetError}`
        : null;
    const pulled = report.pulled.length + (assets?.pulled ?? 0);
    const pushed = report.pushed.length + (assets?.pushed ?? 0);
    const conflictCount = report.conflicts.length + (assets?.conflicts.length ?? 0);
    const parts: string[] = [];
    if (pulled) parts.push(`${pulled} pulled`);
    if (pushed) parts.push(`${pushed} pushed`);
    if (report.merged.length) parts.push(`${report.merged.length} merged`);
    if (report.deletedRemote.length) parts.push(`${report.deletedRemote.length} removed from cloud`);
    if (report.deletedLocal.length) parts.push(`${report.deletedLocal.length} removed locally`);
    if (assets?.deleted) parts.push(`${assets.deleted} removed`);
    if (privacy.touchedRemote) parts.push(`${privacy.touchedRemote} privacy update(s)`);
    if (conflictCount) parts.push(`${conflictCount} conflict(s)`);
    lastSummary = parts.length ? parts.join(", ") : "Up to date";
    if (
      report.pulled.length ||
      report.merged.length ||
      report.conflicts.length ||
      assets?.localChanged ||
      privacy.changedLocal
    ) {
      broadcast("vault:changed", undefined);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    syncing = false;
    void notifyStatus();
    if (queued) {
      queued = false;
      scheduleSync(500);
    }
  }
  return syncStatus();
}

// ── Asset sync (binary files: images embedded in notes) ─────────────────────
// Runs after each markdown sync. Storage objects live at
// `<workspaceId>/<vault-relative-path>` in the private "vault-assets" bucket;
// the `assets` table is the metadata index (sha256 drives change detection).
// The plan itself (planAssetSync) is pure and unit-tested — this executes it.

interface AssetSyncOutcome {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: string[];
  /** True when local files changed (the renderer should refresh). */
  localChanged: boolean;
}

async function syncAssets(
  c: KestravaultSupabaseClient,
  workspaceId: string,
  privacyRules: PrivacyRule[],
): Promise<AssetSyncOutcome> {
  const storage = c.storage.from(ASSET_BUCKET);
  const prefix = `${workspaceId}/`;
  const shouldSyncAsset = (path: string): boolean =>
    shouldSyncPrivacyMode(resolveEffectivePrivacy(path, "file", privacyRules).mode);

  // Local: hash every asset file. Vaults hold tens of images, not thousands —
  // rehashing per run keeps this stateless and correct after external edits.
  const local: ShaMap = {};
  for (const { path } of await listAssetFiles()) {
    if (!shouldSyncAsset(path)) continue;
    local[path] = createHash("sha256")
      .update(await readBinaryRaw(path))
      .digest("hex");
  }

  // Remote: the assets table rows for this workspace.
  const { data: rows, error } = await c.from("assets").select("*").eq("workspace_id", workspaceId);
  if (error) throw new Error(`assets list failed: ${error.message}`);
  const remote: ShaMap = {};
  const excludedRemote: string[] = [];
  for (const row of rows ?? []) {
    if (row.storage_path.startsWith(prefix)) {
      const path = row.storage_path.slice(prefix.length);
      if (shouldSyncAsset(path)) remote[path] = row.sha256;
      else excludedRemote.push(path);
    }
  }

  const state = (await readVaultJson<ShaMap>(ASSET_STATE_FILE)) ?? {};
  const plan = planAssetSync(local, remote, state);
  const nextState: ShaMap = {};
  // Paths already in sync carry straight over.
  for (const [path, sha] of Object.entries(local)) {
    if (remote[path] === sha) nextState[path] = sha;
  }

  const upload = async (path: string): Promise<void> => {
    const bytes = await readBinaryRaw(path);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const { error: upErr } = await storage.upload(prefix + path, bytes, {
      upsert: true,
      contentType: assetMime(path),
    });
    if (upErr) throw new Error(`asset upload failed (${path}): ${upErr.message}`);
    const { error: rowErr } = await c.from("assets").upsert(
      {
        id: ulid(),
        workspace_id: workspaceId,
        storage_path: prefix + path,
        mime: assetMime(path),
        sha256: sha,
        created_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,storage_path", ignoreDuplicates: false },
    );
    if (rowErr) throw new Error(`asset row upsert failed (${path}): ${rowErr.message}`);
    nextState[path] = sha;
  };

  const download = async (path: string): Promise<void> => {
    const { data, error: dlErr } = await storage.download(prefix + path);
    if (dlErr || !data) {
      throw new Error(`asset download failed (${path}): ${dlErr?.message ?? "no data"}`);
    }
    await writeBinaryRaw(path, Buffer.from(await data.arrayBuffer()));
    nextState[path] = remote[path]!;
  };

  const outcome: AssetSyncOutcome = {
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflicts: [],
    localChanged: false,
  };

  for (const path of plan.upload) {
    await upload(path);
    outcome.pushed++;
  }
  for (const path of plan.download) {
    await download(path);
    outcome.pulled++;
    outcome.localChanged = true;
  }
  for (const path of plan.deleteRemote) {
    await storage.remove([prefix + path]);
    await c
      .from("assets")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("storage_path", prefix + path);
    outcome.deleted++;
  }
  for (const path of excludedRemote) {
    await storage.remove([prefix + path]);
    await c
      .from("assets")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("storage_path", prefix + path);
    outcome.deleted++;
  }
  for (const path of plan.deleteLocal) {
    await deleteEntry(path);
    outcome.deleted++;
    outcome.localChanged = true;
  }
  for (const { path, conflictPath } of plan.conflicts) {
    // Remote stays canonical at `path`; the local bytes survive (and sync to
    // everyone) as the conflict copy — same policy as markdown.
    await writeBinaryRaw(conflictPath, await readBinaryRaw(path));
    await upload(conflictPath);
    await download(path);
    outcome.conflicts.push(path);
    outcome.localChanged = true;
  }

  await writeVaultJson(ASSET_STATE_FILE, nextState);
  return outcome;
}

let syncTimer: NodeJS.Timeout | null = null;

/** Debounced sync trigger — safe to call from anywhere (no-ops when idle). */
export function scheduleSync(delayMs: number = LOCAL_DEBOUNCE_MS): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow();
  }, delayMs);
  syncTimer.unref?.();
}

let intervalTimer: NodeJS.Timeout | null = null;
let realtimeChannel: RealtimeChannel | null = null;
let presenceChannel: RealtimeChannel | null = null;
let presenceSubscribed = false;

/** The note this window is editing right now (shared with other members). */
let currentNote: { path: string; title: string } | null = null;

/** Renderer callback: the active note changed — re-broadcast our presence. */
export function setActiveNote(path: string | null, title: string | null): void {
  currentNote = path ? { path, title: title ?? path } : null;
  void trackPresence();
}

async function trackPresence(): Promise<void> {
  if (!presenceChannel || !presenceSubscribed) return;
  const session = await ensureSession();
  if (!session) return;
  await presenceChannel
    .track({
      email: session.user.email ?? null,
      notePath: currentNote?.path ?? null,
      noteTitle: currentNote?.title ?? null,
    })
    .catch(() => undefined); // presence is best-effort, never breaks sync
}

function broadcastPresence(selfId: string): void {
  if (!presenceChannel) return;
  const state = presenceChannel.presenceState<{
    email: string | null;
    notePath: string | null;
    noteTitle: string | null;
  }>();
  const entries: PresenceEntry[] = Object.entries(state).map(([userId, metas]) => {
    const meta = metas[metas.length - 1]; // newest connection wins per user
    return {
      userId,
      email: meta?.email ?? null,
      notePath: meta?.notePath ?? null,
      noteTitle: meta?.noteTitle ?? null,
      isSelf: userId === selfId,
    };
  });
  broadcast("collab:presence-changed", entries);
}

async function startRealtime(): Promise<void> {
  const c = await getClient();
  const link = await readLink();
  if (realtimeChannel) {
    void realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }
  if (presenceChannel) {
    void presenceChannel.unsubscribe();
    presenceChannel = null;
    presenceSubscribed = false;
    broadcast("collab:presence-changed", []);
  }
  const session = c && link ? await ensureSession() : null;
  if (!c || !link || !session) return;
  realtimeChannel = c
    .channel(`sync-files-${link.workspaceId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "files",
        filter: `workspace_id=eq.${link.workspaceId}`,
      },
      () => scheduleSync(REMOTE_DEBOUNCE_MS),
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "assets",
        filter: `workspace_id=eq.${link.workspaceId}`,
      },
      () => scheduleSync(REMOTE_DEBOUNCE_MS),
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "privacy_rules",
        filter: `workspace_id=eq.${link.workspaceId}`,
      },
      () => scheduleSync(REMOTE_DEBOUNCE_MS),
    )
    .subscribe();

  // Presence: who's connected to this workspace, and which note they're on.
  // Keyed by user id so multiple windows/devices of one person collapse into
  // a single entry ("X is editing Y" — plan/sync-collab-open-core.md §2).
  const selfId = session.user.id;
  presenceChannel = c.channel(`presence-${link.workspaceId}`, {
    config: { presence: { key: selfId } },
  });
  presenceChannel
    .on("presence", { event: "sync" }, () => broadcastPresence(selfId))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        presenceSubscribed = true;
        void trackPresence();
      }
    });
}

/** Start background sync (launch + interval + realtime). Call once at ready. */
export function initSync(): void {
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
  intervalTimer.unref?.();
  scheduleSync(3_000); // initial sync shortly after launch
  void startRealtime();
}

/** Re-arm realtime + state after the vault or the link changed. */
export function syncTargetChanged(): void {
  void startRealtime();
  scheduleSync(1_000);
}

// ── Renderer-facing operations (wired to IPC in index.ts) ───────────────────

export async function getSyncConfig(): Promise<SyncConfigInfo> {
  const s = await loadSettings();
  const server = await activeServer();
  return {
    mode: s.mode,
    hostedAvailable: hostedConfig() !== null,
    selfHostUrl: s.selfHostUrl,
    hasSelfHostKey: !!getSecret(SYNC_SERVER_SECRET_ID),
    configured: server !== null,
  };
}

export async function setSyncConfig(input: {
  mode: SyncMode;
  selfHostUrl?: string;
  selfHostKey?: string;
}): Promise<SyncConfigInfo> {
  const s = await loadSettings();
  await saveSettings({
    mode: input.mode,
    selfHostUrl: input.selfHostUrl?.trim() ?? s.selfHostUrl,
  });
  if (typeof input.selfHostKey === "string") {
    await setSecret(SYNC_SERVER_SECRET_ID, input.selfHostKey);
  }
  client = null; // reconnect against the new server
  sessionRestored = false;
  void notifyStatus();
  return getSyncConfig();
}

export async function signUp(email: string, password: string): Promise<string> {
  const c = await getClient();
  if (!c) throw new Error("No sync server configured.");
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  if (data.session) {
    await persistSession(data.session);
    void notifyStatus();
    return "Account created — you're signed in.";
  }
  return "Account created — check your email to confirm, then sign in.";
}

export async function signIn(email: string, password: string): Promise<SyncAccount> {
  const c = await getClient();
  if (!c) throw new Error("No sync server configured.");
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  await persistSession(data.session);
  void notifyStatus();
  syncTargetChanged();
  const account = await accountInfo();
  if (!account) throw new Error("Signed in, but the session could not be read back.");
  return account;
}

export async function signOut(): Promise<void> {
  const c = await getClient();
  if (c) await c.auth.signOut().catch(() => undefined);
  await persistSession(null);
  void notifyStatus();
}

/** Redeem a lifetime access code for the signed-in user (pre-Stripe beta).
 *  Resolves to the refreshed account so the UI flips to "plan active". */
export async function redeemLifetimeCode(code: string): Promise<SyncAccount> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) throw new Error("Sign in first.");
  await new SupabaseEntitlementRepo(c).redeemLifetimeCode(code);
  const account = await accountInfo();
  if (!account) throw new Error("Code redeemed, but the account could not be read back.");
  return account;
}

export async function accountInfo(): Promise<SyncAccount | null> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) return null;
  const entitlements = new SupabaseEntitlementRepo(c);
  let hasActivePlan = false;
  try {
    hasActivePlan = await entitlements.hasActivePlan(session.user.id);
  } catch {
    // Older server without the entitlements migration — treat as no plan.
  }
  return { userId: session.user.id, email: session.user.email ?? null, hasActivePlan };
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) return [];
  // RLS scopes this to workspaces the user is a member of (owner or member).
  const { data, error } = await c.from("workspaces").select("*");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.owner_id === session.user.id ? ("owner" as const) : ("member" as const),
      createdAt: row.created_at,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) throw new Error("Sign in first.");
  const repo = new SupabaseWorkspaceRepo(c);
  // The entitlements trigger enforces the paid plan + the 3-vault cap here.
  const workspace = await repo.upsert({
    id: ulid(),
    ownerId: session.user.id,
    name: name.trim() || "My vault",
    createdAt: new Date().toISOString(),
    config: { ingestMode: "async", runMode: "default", scaffold: [] },
  });
  return {
    id: workspace.id,
    name: workspace.name,
    role: "owner",
    createdAt: workspace.createdAt,
  };
}

export async function linkVault(workspaceId: string, workspaceName: string): Promise<void> {
  await writeVaultJson(LINK_FILE, { workspaceId, workspaceName } satisfies VaultLink);
  await writeVaultJson(STATE_FILE, emptySyncState(workspaceId));
  syncTargetChanged();
}

export async function unlinkVault(): Promise<void> {
  await deleteEntry(LINK_FILE).catch(() => undefined);
  await deleteEntry(STATE_FILE).catch(() => undefined);
  if (realtimeChannel) {
    void realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }
  if (presenceChannel) {
    void presenceChannel.unsubscribe();
    presenceChannel = null;
    presenceSubscribed = false;
    broadcast("collab:presence-changed", []);
  }
  void notifyStatus();
}

// ── Shared-workspace membership (Feature A) ──────────────────────────────────

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) return [];
  const repo = new SupabaseMembershipRepo(c);
  const members = await repo.listMembers(workspaceId);
  // Resolve ids -> emails; degrade to ids on servers without the
  // member_directory migration (or any transient failure).
  const emails = new Map<string, string | null>();
  try {
    for (const entry of await repo.memberDirectory(workspaceId)) {
      emails.set(entry.userId, entry.email);
    }
  } catch {
    // Older server — the UI shows truncated ids instead.
  }
  return members.map((member) => ({
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt,
    isSelf: member.userId === session.user.id,
    email: emails.get(member.userId) ?? null,
  }));
}

/** The attributed change feed for the vault's linked workspace. */
export async function changeFeed(limit = 50): Promise<FeedEntry[]> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  const link = await readLink();
  if (!c || !session || !link) return [];
  const repo = new SupabaseMembershipRepo(c);
  try {
    const entries = await repo.changeFeed(link.workspaceId, limit);
    return entries.map((entry) => ({
      versionId: entry.versionId,
      path: entry.path,
      title: entry.title,
      version: entry.version,
      updatedBy: entry.updatedBy,
      authorEmail: entry.authorEmail,
      isSelf: entry.authorId === session.user.id,
      deleted: entry.deleted,
      createdAt: entry.createdAt,
    }));
  } catch {
    return []; // older server without the change-feed migration
  }
}

/** Recent agent change-sets for the linked workspace (the revert surface). */
export async function agentChangeSets(limit = 20): Promise<AgentChangeSetSummary[]> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  const link = await readLink();
  if (!c || !session || !link) return [];

  const changeSets = new SupabaseChangeSetRepo(c);
  const files = new SupabaseFileRepo(c);
  const rows = (await changeSets.listByWorkspace(link.workspaceId))
    .filter((cs) => cs.kind !== "manual")
    .slice(0, Math.max(1, Math.min(limit, 50)));

  return Promise.all(
    rows.map(async (cs) => {
      const changes = await changeSets.listChanges(cs.id);
      const paths: string[] = [];
      for (const change of changes.slice(0, 4)) {
        const file = await files.get(change.fileId);
        if (file) paths.push(file.path);
      }
      return {
        id: cs.id,
        kind: cs.kind,
        summary: cs.summary,
        authorId: cs.authorId,
        createdAt: cs.createdAt,
        reverted: cs.reverted,
        fileCount: changes.length,
        paths,
      };
    }),
  );
}

/** One-click inverse apply for an agent change-set. Refuses stale overwrites. */
export async function revertAgentChangeSet(
  changeSetId: string,
): Promise<RevertAgentChangeSetResult> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) throw new Error("Sign in first.");
  const result = await revertChangeSet(changeSetId, {
    files: new SupabaseFileRepo(c),
    changeSets: new SupabaseChangeSetRepo(c),
    authorId: session.user.id,
    newId: ulid,
    now: () => new Date().toISOString(),
  }).catch((err: unknown) => {
    if (err instanceof RevertChangeSetError && err.code === "already_changed") {
      throw new Error(
        "This change-set cannot be reverted because one of its files has newer work. Review the touched files and merge manually.",
      );
    }
    throw err;
  });

  void syncNow().catch(() => undefined);
  return {
    status: result.status,
    changeSetId: result.changeSetId,
    revertChangeSetId: result.revertChangeSetId,
    fileCount: result.files.length,
  };
}

export async function createInvite(workspaceId: string, email: string | null): Promise<string> {
  const c = await getClient();
  if (!c || !(await ensureSession())) throw new Error("Sign in first.");
  const repo = new SupabaseMembershipRepo(c);
  const invite = await repo.createInvite({
    id: ulid(),
    token: mintPublicToken(),
    workspaceId,
    invitedEmail: email?.trim() || null,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    redeemedBy: null,
    createdAt: new Date().toISOString(),
  });
  return invite.token;
}

export async function redeemInvite(token: string): Promise<WorkspaceSummary[]> {
  const c = await getClient();
  const session = c ? await ensureSession() : null;
  if (!c || !session) throw new Error("Sign in first.");
  const repo = new SupabaseMembershipRepo(c);
  await repo.redeemInvite(token.trim(), session.user.id);
  return listWorkspaces();
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  const c = await getClient();
  if (!c || !(await ensureSession())) throw new Error("Sign in first.");
  const { error } = await c
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}
