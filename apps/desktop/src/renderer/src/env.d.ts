/// <reference types="vite/client" />

import type { VaultInfo, VaultNode } from "@renderer/vault/types";
import type { PrivacyMode, PrivacyRule, PrivacyTarget } from "@kestravault/core";

// Shape of the bridge exposed by src/preload/index.ts. Kept as a standalone
// declaration (rather than importing the preload module) so the renderer
// typecheck stays free of Node/Electron types.
interface VaultApi {
  root(): Promise<string>;
  tree(): Promise<VaultNode[]>;
  privacyRules(): Promise<PrivacyRule[]>;
  setPrivacy(path: string, target: PrivacyTarget, mode: PrivacyMode): Promise<void>;
  clearPrivacy(path: string, target: PrivacyTarget): Promise<void>;
  read(path: string): Promise<string>;
  readMany(paths: string[]): Promise<Array<{ path: string; content: string }>>;
  write(path: string, content: string): Promise<void>;
  /** Read a binary asset (image) as base64 for a data: URL. */
  readBinary(path: string): Promise<string>;
  /** Write a binary asset from base64; resolves to the path actually written. */
  writeBinary(path: string, base64: string): Promise<string>;
  create(path: string, content?: string): Promise<string>;
  createDir(path: string): Promise<string>;
  rename(path: string, next: string): Promise<string>;
  remove(path: string): Promise<void>;
  reveal(path?: string): Promise<void>;
  onChanged(cb: () => void): () => void;
  // Multiple vaults (Obsidian-style).
  list(): Promise<VaultInfo[]>;
  switch(path: string): Promise<string>;
  add(): Promise<string | null>;
  createVault(): Promise<string | null>;
  removeVault(path: string): Promise<VaultInfo[]>;
}

export type AiChatRole = "user" | "assistant";
export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}
export type AiProviderKind = "subscription" | "openai-sub" | "anthropic" | "openai";
export interface AiProviderConfig {
  kind: AiProviderKind;
  /** Which provider preset — the main process resolves the key from this. */
  providerId?: string;
  baseUrl?: string;
}
/** Reasoning effort for provider/model combinations that support it. */
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
export type AgentOpKind = "file" | "tidy" | "organize" | "custom";
export interface AgentOpRequest {
  requestId: string;
  op: AgentOpKind;
  targetPath?: string;
  /** The instruction for a `custom` op (a user-defined skill's prompt). */
  prompt?: string;
  model?: string;
  provider?: AiProviderConfig;
}
export interface AgentChangedFile {
  path: string;
  op: "create" | "update" | "move";
  /** Previous path when `op` is "move". */
  from?: string;
}
export type AgentOpEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; action: "read" | "search" | "write" | "move"; path?: string }
  | { requestId: string; type: "done"; text: string; changed: AgentChangedFile[] }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };

interface AiApi {
  send(req: AiSendRequest): Promise<void>;
  cancel(requestId: string): Promise<void>;
  status(provider?: AiProviderConfig, force?: boolean): Promise<AiStatus>;
  resetStatus(): Promise<void>;
  /** Models the provider can serve right now (live discovery, best-effort). */
  models(provider?: AiProviderConfig): Promise<{ id: string; label: string }[]>;
  onEvent(cb: (e: AiEvent) => void): () => void;
  agent(req: AgentOpRequest): Promise<void>;
  onAgentEvent(cb: (e: AgentOpEvent) => void): () => void;
}

interface SecretApi {
  set(providerId: string, key: string): Promise<void>;
  list(): Promise<string[]>;
  available(): Promise<boolean>;
}

// ── Activity log (mirror of main/activity.ts) ──
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

interface ActivityApi {
  record(evt: ActivityEventInput): Promise<void>;
  context(opts?: { deep?: boolean }): Promise<ActivityContextPayload>;
  summary(): Promise<ActivitySummary>;
  reveal(): Promise<void>;
  clear(): Promise<void>;
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

// Self-host reachability probe (mirror of main/syncServer.ts) — verifies a
// self-hosted server's auth/rest/storage health before you sign in.
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

interface SyncApi {
  getConfig(): Promise<SyncConfigInfo>;
  setConfig(input: {
    mode: SyncMode;
    selfHostUrl?: string;
    selfHostKey?: string;
  }): Promise<SyncConfigInfo>;
  signUp(email: string, password: string): Promise<string>;
  signIn(email: string, password: string): Promise<SyncAccount>;
  signOut(): Promise<void>;
  account(): Promise<SyncAccount | null>;
  /** Redeem a lifetime access code (pre-Stripe beta). */
  redeemCode(code: string): Promise<SyncAccount>;
  status(): Promise<SyncStatusInfo>;
  now(): Promise<SyncStatusInfo>;
  workspaces(): Promise<WorkspaceSummary[]>;
  createWorkspace(name: string): Promise<WorkspaceSummary>;
  link(workspaceId: string, workspaceName: string): Promise<void>;
  unlink(): Promise<void>;
  onStatus(cb: (status: SyncStatusInfo) => void): () => void;
  /** Probe a self-hosted server's auth/rest/storage health. */
  test(url: string): Promise<SyncTestResult>;
}

interface CollabApi {
  members(workspaceId: string): Promise<MemberSummary[]>;
  invite(workspaceId: string, email: string | null): Promise<string>;
  join(token: string): Promise<WorkspaceSummary[]>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  /** Attributed change feed for the linked workspace, newest first. */
  feed(limit?: number): Promise<FeedEntry[]>;
  /** Recent agent change-sets for the linked workspace. */
  changeSets(limit?: number): Promise<AgentChangeSetSummary[]>;
  /** Apply the inverse of a change-set, refusing to overwrite newer work. */
  revertChangeSet(changeSetId: string): Promise<RevertAgentChangeSetResult>;
  /** Report the note being edited (drives "X is editing Y" presence). */
  setActiveNote(path: string | null, title: string | null): void;
  /** Subscribe to workspace presence pushes. Returns an unsubscribe fn. */
  onPresence(cb: (entries: PresenceEntry[]) => void): () => void;
}

// ── Update notifications (mirror of main/updates.ts) ──
export interface UpdateInfo {
  /** Version of the latest release, without the leading `v`. */
  version: string;
  /** GitHub release page to open in the browser. */
  url: string;
}

interface UpdatesApi {
  setEnabled(enabled: boolean): Promise<void>;
  onAvailable(cb: (info: UpdateInfo) => void): () => void;
}

declare global {
  interface Window {
    api: {
      platform: string;
      versions: { electron: string; chrome: string; node: string };
      app: { version(): Promise<string> };
      vault: VaultApi;
      ai: AiApi;
      secret: SecretApi;
      sync: SyncApi;
      activity: ActivityApi;
      updates: UpdatesApi;
      collab: CollabApi;
    };
  }
}

export {};
