import { contextBridge, ipcRenderer } from "electron";
import type { EffectivePrivacy, PrivacyMode, PrivacyRule, PrivacyTarget } from "@kestravault/core";

// A markdown file or folder in the vault tree.
export type VaultNode =
  | { kind: "file"; name: string; path: string; private?: boolean; privacy: EffectivePrivacy }
  | { kind: "dir"; name: string; path: string; children: VaultNode[]; privacy: EffectivePrivacy };

// A known vault, as listed in the vault switcher.
export interface VaultInfo {
  path: string;
  name: string;
  current: boolean;
}

// ── AI types (mirror of main/ai.ts, kept here so the renderer needs no import
//    from the main process) ──
export type AiChatRole = "user" | "assistant";
export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}
export type AiProviderKind = "subscription" | "anthropic" | "openai";
export interface AiProviderConfig {
  kind: AiProviderKind;
  /** Which provider preset — the main process resolves the key from this. */
  providerId?: string;
  baseUrl?: string;
}
export type EffortLevel = "low" | "medium" | "high";
export interface AiSendRequest {
  requestId: string;
  system: string;
  messages: AiChatMessage[];
  model?: string;
  provider?: AiProviderConfig;
  /** Reasoning effort; omitted → provider default. */
  effort?: EffortLevel;
}
export type AiErrorKind = "auth" | "rate_limit" | "aborted" | "unknown";
export type AiEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "done"; text: string }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };
export interface AiStatus {
  connected: boolean;
  detail?: string;
  kind?: AiErrorKind;
}

// ── Vault agent operations (mirror of main/agentOps.ts) ──
export type AgentOpKind = "ingest" | "lint";
export interface AgentOpRequest {
  requestId: string;
  op: AgentOpKind;
  targetPath?: string;
  model?: string;
  provider?: AiProviderConfig;
}
export interface AgentChangedFile {
  path: string;
  op: "create" | "update";
}
export type AgentOpEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; action: "read" | "search" | "write"; path?: string }
  | { requestId: string; type: "done"; text: string; changed: AgentChangedFile[] }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };

// ── Activity log types (mirror of main/activity.ts) ──
export type ActivityType = "open" | "edit" | "create" | "rename" | "delete" | "ask";
export interface ActivityEventInput {
  type: ActivityType;
  path: string;
  title?: string;
  note?: string;
}
export interface ActivityItem {
  title: string;
  verb: "created" | "edited" | "renamed" | "deleted" | "opened";
  path: string;
}
export interface ActivityDay {
  day: string;
  items: ActivityItem[];
}
export interface WeekTopItem {
  title: string;
  edits: number;
}
export interface ActivityDeadline {
  title: string;
  path: string;
  due: string;
  daysLeft: number;
}
export interface ActivityContextPayload {
  today: ActivityItem[];
  yesterday: ActivityItem[];
  weekTop: WeekTopItem[];
  recentDays: ActivityDay[];
  deadlines: ActivityDeadline[];
}
export interface ActivitySummary {
  total: number;
  since: number | null;
}

// ── Cloud sync + shared workspaces (mirror of main/sync.ts) ──
export type SyncMode = "hosted" | "self-hosted";
export interface SyncConfigInfo {
  mode: SyncMode;
  hostedAvailable: boolean;
  selfHostUrl: string;
  hasSelfHostKey: boolean;
  configured: boolean;
}
export interface SyncAccount {
  userId: string;
  email: string | null;
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
  /** Account email (null on servers without the member-directory migration). */
  email: string | null;
}
/** One row of the attributed change feed (mirror of main/sync.ts FeedEntry). */
export interface FeedEntry {
  versionId: string;
  path: string;
  title: string;
  version: number;
  updatedBy: string;
  authorEmail: string | null;
  isSelf: boolean;
  deleted: boolean;
  createdAt: string;
}
/** One agent change-set that can be reverted from Activity. */
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
/** One person connected to the linked workspace (Realtime presence). */
export interface PresenceEntry {
  userId: string;
  email: string | null;
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
  conflicts: string[];
}

// Self-host reachability probe (mirror of main/syncServer.ts).
export type SyncService = "auth" | "rest" | "storage";
export interface SyncServiceStatus {
  service: SyncService;
  ok: boolean;
  detail?: string;
}
export interface SyncTestResult {
  ok: boolean;
  services: SyncServiceStatus[];
  detail?: string;
}

// ── Update notifications (mirror of main/updates.ts) ──
export interface UpdateInfo {
  /** Version of the latest release, without the leading `v`. */
  version: string;
  /** GitHub release page to open in the browser. */
  url: string;
}

// The safe surface exposed to the renderer. All filesystem access funnels
// through these IPC calls — the renderer has no direct Node/fs access.
const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  app: {
    /** The app's own version (package.json via app.getVersion()). */
    version: (): Promise<string> => ipcRenderer.invoke("app:version"),
  },
  // Update notifications. The renderer flips checking on/off (mirroring the
  // Settings toggle) and hears back when a newer GitHub release exists. v1 is
  // notify-only: the banner links to the release page, nothing auto-installs.
  updates: {
    /** Enable (launch + daily checks) or disable (zero network calls). */
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("update:set-enabled", enabled),
    /** Subscribe to "a newer release exists". Returns an unsubscribe fn. */
    onAvailable: (cb: (info: UpdateInfo) => void): (() => void) => {
      const listener = (_e: unknown, info: UpdateInfo): void => cb(info);
      ipcRenderer.on("update:available", listener);
      return () => ipcRenderer.removeListener("update:available", listener);
    },
  },
  vault: {
    root: (): Promise<string> => ipcRenderer.invoke("vault:root"),
    tree: (): Promise<VaultNode[]> => ipcRenderer.invoke("vault:tree"),
    privacyRules: (): Promise<PrivacyRule[]> => ipcRenderer.invoke("vault:get-privacy-rules"),
    setPrivacy: (
      path: string,
      target: PrivacyTarget,
      mode: PrivacyMode,
    ): Promise<void> => ipcRenderer.invoke("vault:set-privacy", path, target, mode),
    clearPrivacy: (path: string, target: PrivacyTarget): Promise<void> =>
      ipcRenderer.invoke("vault:clear-privacy", path, target),
    /** All known vaults, with the open one flagged `current`. */
    list: (): Promise<VaultInfo[]> => ipcRenderer.invoke("vault:list"),
    /** Switch to a known vault; resolves to the new vault root. */
    switch: (path: string): Promise<string> => ipcRenderer.invoke("vault:switch", path),
    /** Open a folder picker to add an existing folder as a vault. Null if cancelled. */
    add: (): Promise<string | null> => ipcRenderer.invoke("vault:add"),
    /** Open a folder picker to create a new (seeded) vault. Null if cancelled. */
    createVault: (): Promise<string | null> => ipcRenderer.invoke("vault:create"),
    /** Forget a vault from the list (does not delete files). Returns the new list. */
    removeVault: (path: string): Promise<VaultInfo[]> => ipcRenderer.invoke("vault:remove", path),
    read: (path: string): Promise<string> => ipcRenderer.invoke("file:read", path),
    write: (path: string, content: string): Promise<void> =>
      ipcRenderer.invoke("file:write", path, content),
    /** Read a binary asset (image) as base64 for a data: URL. */
    readBinary: (path: string): Promise<string> => ipcRenderer.invoke("file:read-binary", path),
    /** Write a binary asset from base64; resolves to the path actually written. */
    writeBinary: (path: string, base64: string): Promise<string> =>
      ipcRenderer.invoke("file:write-binary", path, base64),
    create: (path: string, content?: string): Promise<string> =>
      ipcRenderer.invoke("file:create", path, content),
    createDir: (path: string): Promise<string> => ipcRenderer.invoke("dir:create", path),
    rename: (path: string, next: string): Promise<string> =>
      ipcRenderer.invoke("entry:rename", path, next),
    remove: (path: string): Promise<void> => ipcRenderer.invoke("entry:delete", path),
    reveal: (path?: string): Promise<void> => ipcRenderer.invoke("vault:reveal", path),
    /** Subscribe to external vault changes. Returns an unsubscribe fn. */
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("vault:changed", listener);
      return () => ipcRenderer.removeListener("vault:changed", listener);
    },
  },
  ai: {
    /** Start a streamed request. Listen via `onEvent` for deltas/done/error. */
    send: (req: AiSendRequest): Promise<void> => ipcRenderer.invoke("ai:send", req),
    /** Abort an in-flight request by id (keeps whatever streamed so far). */
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke("ai:cancel", requestId),
    /** Probe whether the given provider is reachable. Cached per provider. */
    status: (provider?: AiProviderConfig, force = false): Promise<AiStatus> =>
      ipcRenderer.invoke("ai:status", provider, force),
    /** Drop the cached status so the next `status()` re-probes. */
    resetStatus: (): Promise<void> => ipcRenderer.invoke("ai:reset-status"),
    /** Subscribe to streamed AI events. Returns an unsubscribe fn. */
    onEvent: (cb: (e: AiEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: AiEvent): void => cb(payload);
      ipcRenderer.on("ai:event", listener);
      return () => ipcRenderer.removeListener("ai:event", listener);
    },
    /** Run a vault agent operation (Ingest / Lint). Streams via `onAgentEvent`;
     *  cancellable with `cancel` (request ids are shared across both paths). */
    agent: (req: AgentOpRequest): Promise<void> => ipcRenderer.invoke("ai:agent", req),
    /** Subscribe to streamed agent-op events. Returns an unsubscribe fn. */
    onAgentEvent: (cb: (e: AgentOpEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: AgentOpEvent): void => cb(payload);
      ipcRenderer.on("ai:agent-event", listener);
      return () => ipcRenderer.removeListener("ai:agent-event", listener);
    },
  },
  // Local activity log. The renderer records lifecycle events (fire-and-forget)
  // and asks for small aggregated digests to feed the AI's context — the raw log
  // stays in the main process (see main/activity.ts).
  activity: {
    /** Record one event. Never rejects meaningfully — logging is best-effort. */
    record: (evt: ActivityEventInput): Promise<void> => ipcRenderer.invoke("activity:record", evt),
    /** Aggregated digest for the current vault. `deep` adds a 30-day breakdown. */
    context: (opts?: { deep?: boolean }): Promise<ActivityContextPayload> =>
      ipcRenderer.invoke("activity:context", opts),
    /** Event count + earliest timestamp, for the Settings screen. */
    summary: (): Promise<ActivitySummary> => ipcRenderer.invoke("activity:summary"),
    /** Reveal the raw JSONL log in the OS file manager. */
    reveal: (): Promise<void> => ipcRenderer.invoke("activity:reveal"),
    /** Erase the entire activity history. */
    clear: (): Promise<void> => ipcRenderer.invoke("activity:clear"),
  },
  // Cloud sync + shared workspaces. All Supabase traffic stays in the main
  // process; the renderer sees typed summaries only. AI is deliberately
  // separate — every member brings their own key / Claude login (api.ai).
  sync: {
    getConfig: (): Promise<SyncConfigInfo> => ipcRenderer.invoke("sync:config:get"),
    setConfig: (input: {
      mode: SyncMode;
      selfHostUrl?: string;
      selfHostKey?: string;
    }): Promise<SyncConfigInfo> => ipcRenderer.invoke("sync:config:set", input),
    /** Create an account. Resolves to a human-readable next-step message. */
    signUp: (email: string, password: string): Promise<string> =>
      ipcRenderer.invoke("sync:signup", email, password),
    signIn: (email: string, password: string): Promise<SyncAccount> =>
      ipcRenderer.invoke("sync:signin", email, password),
    signOut: (): Promise<void> => ipcRenderer.invoke("sync:signout"),
    /** The signed-in account (with plan state), or null. */
    account: (): Promise<SyncAccount | null> => ipcRenderer.invoke("sync:account"),
    /** Redeem a lifetime access code (pre-Stripe beta); resolves to the
     *  refreshed account with the plan now active. */
    redeemCode: (code: string): Promise<SyncAccount> =>
      ipcRenderer.invoke("sync:redeem-code", code),
    status: (): Promise<SyncStatusInfo> => ipcRenderer.invoke("sync:status"),
    /** Run a sync now; resolves with the post-run status. */
    now: (): Promise<SyncStatusInfo> => ipcRenderer.invoke("sync:now"),
    /** Workspaces the user can see (owner or invited member). */
    workspaces: (): Promise<WorkspaceSummary[]> => ipcRenderer.invoke("sync:workspaces"),
    /** Create a cloud workspace (server enforces plan + 3-vault cap). */
    createWorkspace: (name: string): Promise<WorkspaceSummary> =>
      ipcRenderer.invoke("sync:create-workspace", name),
    /** Bind the CURRENT vault folder to a workspace and start syncing. */
    link: (workspaceId: string, workspaceName: string): Promise<void> =>
      ipcRenderer.invoke("sync:link", workspaceId, workspaceName),
    unlink: (): Promise<void> => ipcRenderer.invoke("sync:unlink"),
    /** Subscribe to sync status pushes. Returns an unsubscribe fn. */
    onStatus: (cb: (status: SyncStatusInfo) => void): (() => void) => {
      const listener = (_e: unknown, status: SyncStatusInfo): void => cb(status);
      ipcRenderer.on("sync:status-changed", listener);
      return () => ipcRenderer.removeListener("sync:status-changed", listener);
    },
    /** Probe a self-hosted server's auth/rest/storage health (selfhost/README.md). */
    test: (url: string): Promise<SyncTestResult> => ipcRenderer.invoke("sync:test", url),
  },
  // Shared-workspace membership: who's in, invite links, joining, removal.
  collab: {
    members: (workspaceId: string): Promise<MemberSummary[]> =>
      ipcRenderer.invoke("collab:members", workspaceId),
    /** Mint a single-use invite token (7-day expiry). Share it as the link. */
    invite: (workspaceId: string, email: string | null): Promise<string> =>
      ipcRenderer.invoke("collab:invite", workspaceId, email),
    /** Redeem an invite token; resolves to the refreshed workspace list. */
    join: (token: string): Promise<WorkspaceSummary[]> => ipcRenderer.invoke("collab:join", token),
    removeMember: (workspaceId: string, userId: string): Promise<void> =>
      ipcRenderer.invoke("collab:remove-member", workspaceId, userId),
    /** Attributed change feed for the linked workspace, newest first. */
    feed: (limit?: number): Promise<FeedEntry[]> => ipcRenderer.invoke("collab:feed", limit),
    /** Recent agent change-sets for the linked workspace. */
    changeSets: (limit?: number): Promise<AgentChangeSetSummary[]> =>
      ipcRenderer.invoke("collab:change-sets", limit),
    /** Apply the inverse of a change-set, refusing to overwrite newer work. */
    revertChangeSet: (changeSetId: string): Promise<RevertAgentChangeSetResult> =>
      ipcRenderer.invoke("collab:revert-change-set", changeSetId),
    /** Report the note being edited (drives "X is editing Y" presence). */
    setActiveNote: (path: string | null, title: string | null): void =>
      ipcRenderer.send("collab:active-note", path, title),
    /** Subscribe to workspace presence pushes. Returns an unsubscribe fn. */
    onPresence: (cb: (entries: PresenceEntry[]) => void): (() => void) => {
      const listener = (_e: unknown, entries: PresenceEntry[]): void => cb(entries);
      ipcRenderer.on("collab:presence-changed", listener);
      return () => ipcRenderer.removeListener("collab:presence-changed", listener);
    },
  },
  // BYOK API keys. Write-only by design: store or clear a key and ask which
  // providers have one, but the plaintext key never comes back across IPC —
  // it's encrypted at rest in the main process (OS keychain via safeStorage).
  secret: {
    /** Save (non-empty) or clear (empty) the key for a provider. */
    set: (providerId: string, key: string): Promise<void> =>
      ipcRenderer.invoke("secret:set", providerId, key),
    /** Provider ids that currently have a key saved. */
    list: (): Promise<string[]> => ipcRenderer.invoke("secret:list"),
    /** Whether the OS keychain is available to encrypt keys at rest. */
    available: (): Promise<boolean> => ipcRenderer.invoke("secret:available"),
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
