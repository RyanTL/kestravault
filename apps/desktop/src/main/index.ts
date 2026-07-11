import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import {
  initVaults,
  vaultRoot,
  listVaults,
  switchVault,
  registerVault,
  removeVault,
  readTree,
  readFile,
  writeFile,
  readPrivacyRules,
  setEntryPrivacy,
  clearEntryPrivacy,
  createFile,
  createDir,
  renameEntry,
  deleteEntry,
  readBinary,
  writeBinary,
} from "./vault.js";
import {
  runAiRequest,
  cancelAiRequest,
  aiStatus,
  resetAiStatus,
  listAiModels,
  type AiSendRequest,
  type AiProviderConfig,
} from "./ai.js";
import { runAgentOp, cancelAgentOp, type AgentOpRequest } from "./agentOps.js";
import type { PrivacyMode, PrivacyTarget } from "@kestravault/core";
import { setSecret, listSecretIds, encryptionAvailable } from "./secrets.js";
import { testSyncServer } from "./syncServer.js";
import {
  recordEvent,
  activityContext,
  activitySummary,
  revealActivityFile,
  clearActivity,
  type ActivityEventInput,
} from "./activity.js";
import { startUpdateChecks, stopUpdateChecks } from "./updates.js";
import { resolveClaudeExecutable } from "./claudeBinary.js";
import {
  accountInfo,
  agentChangeSets,
  changeFeed,
  createInvite,
  createWorkspace,
  getSyncConfig,
  initSync,
  linkVault,
  listMembers,
  listWorkspaces,
  redeemInvite,
  redeemLifetimeCode,
  removeMember,
  revertAgentChangeSet,
  scheduleSync,
  setActiveNote,
  setSyncConfig,
  signIn,
  signOut,
  signUp,
  syncNow,
  syncStatus,
  syncTargetChanged,
  unlinkVault,
  type SyncMode,
} from "./sync.js";

// ── Packaged-build smoke mode ────────────────────────────────────────────────
// scripts/smoke-packaged.sh boots the packaged app with KESTRAVAULT_SMOKE=1: the
// app redirects home/userData into a temp folder (so it never touches real
// data), skips showing a window, verifies the renderer loads and the Claude
// engine binary is where spawn can reach it, prints a machine-readable
// verdict, and exits. Zero effect on a normal launch.
const SMOKE = process.env["KESTRAVAULT_SMOKE"] === "1";
if (SMOKE) {
  const tmp = mkdtempSync(join(tmpdir(), "kestravault-smoke-"));
  app.setPath("home", tmp);
  app.setPath("userData", join(tmp, "userData"));
  // Fail-safe so a hung boot can never block CI.
  setTimeout(() => {
    console.log("KESTRAVAULT_SMOKE:FAIL:timeout");
    app.exit(1);
  }, 30_000).unref();
}

function smokeCheck(win: BrowserWindow): void {
  win.webContents.once("did-finish-load", () => {
    const exe = resolveClaudeExecutable();
    const engineOk = !!exe && existsSync(exe);
    console.log(engineOk ? "KESTRAVAULT_SMOKE:OK" : "KESTRAVAULT_SMOKE:FAIL:engine-binary");
    app.exit(engineOk ? 0 : 1);
  });
  win.webContents.once("did-fail-load", (_e, code, desc) => {
    console.log(`KESTRAVAULT_SMOKE:FAIL:load:${code}:${desc}`);
    app.exit(1);
  });
  win.webContents.once("render-process-gone", (_e, details) => {
    console.log(`KESTRAVAULT_SMOKE:FAIL:renderer:${details.reason}`);
    app.exit(1);
  });
}

// ESM has no __dirname; derive it from the module URL so the preload/renderer
// paths resolve in both `electron-vite dev` (out/) and a packaged build.
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Only hand genuine web/mail links to the OS. shell.openExternal will happily
// launch other schemes (and apps), so we whitelist http(s)/mailto and drop the
// rest — a link is never reason enough to invoke an arbitrary URL handler.
function isExternal(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Open the native folder picker for choosing a vault. `mode` only tweaks the
// copy + button — both let the user navigate to (or create) and select a folder.
async function pickVaultFolder(
  win: BrowserWindow | null,
  mode: "open" | "create",
): Promise<string | null> {
  const opts = {
    properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    buttonLabel: mode === "create" ? "Create Vault" : "Open",
    title: mode === "create" ? "Create new vault" : "Open folder as vault",
    message:
      mode === "create"
        ? "Choose a location, create a new folder, and select it as your vault."
        : "Choose a folder of markdown to open as a vault.",
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

// IPC: app metadata. The renderer shows the version in Settings → About so
// users can compare it against an update notice.
function registerAppIpc(): void {
  ipcMain.handle("app:version", () => app.getVersion());
}

// IPC: update checks. The renderer owns the "Check for updates" setting and
// drives the main-process checker with it — on at mount (default) starts the
// launch + every-24h poll; off stops it, so a disabled toggle means zero
// network calls. Results stream back on "update:available"; the banner's
// download link opens in the default browser via the window-open handler.
function registerUpdateIpc(): void {
  ipcMain.handle("update:set-enabled", (e, enabled: boolean) => {
    if (!enabled) {
      stopUpdateChecks();
      return;
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    startUpdateChecks(app.getVersion(), (info) => {
      if (!win.isDestroyed()) win.webContents.send("update:available", info);
    });
  });
}

// IPC: the renderer never touches the filesystem directly — it goes through
// these handlers, which keep every operation scoped inside the current vault.
function registerVaultIpc(): void {
  ipcMain.handle("vault:root", () => vaultRoot());
  ipcMain.handle("vault:tree", () => readTree());
  ipcMain.handle("vault:get-privacy-rules", () => readPrivacyRules());
  ipcMain.handle(
    "vault:set-privacy",
    (_e, path: string, target: PrivacyTarget, mode: PrivacyMode) => {
      return setEntryPrivacy(path, target, mode).then(() => scheduleSync());
    },
  );
  ipcMain.handle("vault:clear-privacy", (_e, path: string, target: PrivacyTarget) => {
    return clearEntryPrivacy(path, target).then(() => scheduleSync());
  });
  ipcMain.handle("file:read", (_e, relPath: string) => readFile(relPath));
  ipcMain.handle("file:write", (_e, relPath: string, content: string) =>
    writeFile(relPath, content),
  );
  // Binary assets (pasted/embedded images): base64 across IPC, bytes on disk.
  ipcMain.handle("file:read-binary", (_e, relPath: string) => readBinary(relPath));
  ipcMain.handle("file:write-binary", (_e, relPath: string, base64: string) =>
    writeBinary(relPath, base64),
  );
  ipcMain.handle("file:create", (_e, relPath: string, content?: string) =>
    createFile(relPath, content),
  );
  ipcMain.handle("dir:create", (_e, relPath: string) => createDir(relPath));
  ipcMain.handle("entry:rename", (_e, relPath: string, next: string) => renameEntry(relPath, next));
  ipcMain.handle("entry:delete", (_e, relPath: string) => deleteEntry(relPath));
  ipcMain.handle("vault:reveal", (_e, relPath?: string) => {
    shell.showItemInFolder(relPath ? join(vaultRoot(), relPath) : vaultRoot());
  });

  // ── Multiple vaults (Obsidian-style) ──
  ipcMain.handle("vault:list", () => listVaults());
  ipcMain.handle("vault:switch", async (e, path: string) => {
    const root = await switchVault(path);
    rewatch(BrowserWindow.fromWebContents(e.sender));
    syncTargetChanged(); // the new vault may be linked to another workspace
    return root;
  });
  // Open an existing folder as a vault (content left as-is).
  ipcMain.handle("vault:add", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const dir = await pickVaultFolder(win, "open");
    if (!dir) return null;
    const root = await registerVault(dir);
    rewatch(win);
    return root;
  });
  // Create a new vault. It starts empty: the onboarding wizard scaffolds the
  // user's own structure (folders + the AI guide) right after creation.
  ipcMain.handle("vault:create", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const dir = await pickVaultFolder(win, "create");
    if (!dir) return null;
    const root = await registerVault(dir);
    rewatch(win);
    return root;
  });
  // Forget a vault from the list (never deletes it from disk).
  ipcMain.handle("vault:remove", (_e, path: string) => removeVault(path));
}

// IPC for the AI features. The heavy lifting (subscription auth, streaming) is
// in ai.ts; events stream back to whichever window made the request.
function registerAiIpc(): void {
  ipcMain.handle("ai:send", (e, req: AiSendRequest) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) return runAiRequest(win, req);
  });
  ipcMain.handle("ai:cancel", (_e, requestId: string) => {
    // Request ids are unique across both paths; cancel whichever is in flight.
    cancelAiRequest(requestId);
    cancelAgentOp(requestId);
  });
  // Vault agent operations (skills): a real tool-using agent run, guided by
  // the vault's AI guide and guarded by agentOps.ts's tool checks.
  ipcMain.handle("ai:agent", (e, req: AgentOpRequest) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) return runAgentOp(win, req);
  });
  ipcMain.handle("ai:status", (_e, provider?: AiProviderConfig, force?: boolean) =>
    aiStatus(provider, force),
  );
  ipcMain.handle("ai:reset-status", () => resetAiStatus());
  // Live model discovery: what the active provider can serve right now.
  ipcMain.handle("ai:models", (_e, provider?: AiProviderConfig) => listAiModels(provider));
}

// IPC for cloud sync + shared workspaces. All Supabase traffic stays in the
// main process (sync.ts); the renderer only sees typed summaries and status.
function registerSyncIpc(): void {
  ipcMain.handle("sync:config:get", () => getSyncConfig());
  ipcMain.handle(
    "sync:config:set",
    (_e, input: { mode: SyncMode; selfHostUrl?: string; selfHostKey?: string }) =>
      setSyncConfig(input),
  );
  ipcMain.handle("sync:signup", (_e, email: string, password: string) => signUp(email, password));
  ipcMain.handle("sync:signin", (_e, email: string, password: string) => signIn(email, password));
  ipcMain.handle("sync:signout", () => signOut());
  ipcMain.handle("sync:account", () => accountInfo());
  // Pre-Stripe beta: a single-use lifetime code grants the full cloud plan.
  ipcMain.handle("sync:redeem-code", (_e, code: string) => redeemLifetimeCode(code));
  ipcMain.handle("sync:status", () => syncStatus());
  ipcMain.handle("sync:now", () => syncNow());
  ipcMain.handle("sync:workspaces", () => listWorkspaces());
  ipcMain.handle("sync:create-workspace", (_e, name: string) => createWorkspace(name));
  ipcMain.handle("sync:link", (_e, workspaceId: string, workspaceName: string) =>
    linkVault(workspaceId, workspaceName),
  );
  ipcMain.handle("sync:unlink", () => unlinkVault());
  ipcMain.handle("collab:members", (_e, workspaceId: string) => listMembers(workspaceId));
  ipcMain.handle("collab:invite", (_e, workspaceId: string, email: string | null) =>
    createInvite(workspaceId, email),
  );
  ipcMain.handle("collab:join", (_e, token: string) => redeemInvite(token));
  ipcMain.handle("collab:remove-member", (_e, workspaceId: string, userId: string) =>
    removeMember(workspaceId, userId),
  );
  // Attributed change feed for the linked workspace (Activity panel).
  ipcMain.handle("collab:feed", (_e, limit?: number) => changeFeed(limit));
  ipcMain.handle("collab:change-sets", (_e, limit?: number) => agentChangeSets(limit));
  ipcMain.handle("collab:revert-change-set", (_e, changeSetId: string) =>
    revertAgentChangeSet(changeSetId),
  );
  // Presence: the renderer reports the active note (fire-and-forget); everyone
  // in the workspace hears about it via "collab:presence-changed" pushes.
  ipcMain.on("collab:active-note", (_e, path: string | null, title: string | null) =>
    setActiveNote(path, title),
  );
  // Self-host reachability probe (selfhost/README.md): verify a self-hosted
  // server's auth/rest/storage health before signing in. The anon key is read
  // from the encrypted secret store (id "sync-server") inside syncServer.ts.
  ipcMain.handle("sync:test", (_e, url: string) => testSyncServer(url));
}

// IPC for the local activity log. The renderer records lifecycle events and
// asks for aggregated digests; the raw log never leaves the main process (see
// activity.ts). Recording is fire-and-forget so it can't block a user action.
function registerActivityIpc(): void {
  ipcMain.handle("activity:record", (_e, evt: ActivityEventInput) => recordEvent(evt));
  ipcMain.handle("activity:context", (_e, opts?: { deep?: boolean }) => activityContext(opts));
  ipcMain.handle("activity:summary", () => activitySummary());
  ipcMain.handle("activity:reveal", () => revealActivityFile());
  ipcMain.handle("activity:clear", () => clearActivity());
}

// IPC for BYOK API keys. Keys are write-only from the renderer's perspective:
// it can save or clear a key and ask which providers have one, but the plaintext
// key is never returned — it stays in the main process (see secrets.ts).
function registerSecretIpc(): void {
  ipcMain.handle("secret:set", (_e, providerId: string, key: string) => {
    resetAiStatus(); // a changed key must re-probe
    return setSecret(providerId, key);
  });
  ipcMain.handle("secret:list", () => listSecretIds());
  ipcMain.handle("secret:available", () => encryptionAvailable());
}

// Watch the current vault for external changes (edits made in
// Finder/Obsidian/git) and nudge the renderer to reload its tree. Debounced so a
// burst of writes — ours included — collapses into one notification.
let vaultWatcher: FSWatcher | null = null;

function startWatch(win: BrowserWindow): FSWatcher | null {
  let timer: NodeJS.Timeout | null = null;
  try {
    return watch(vaultRoot(), { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send("vault:changed");
      }, 150);
      // Local edits also nudge the cloud sync loop (no-op when not linked).
      scheduleSync();
    });
  } catch {
    // recursive watch is unsupported on some platforms — tree still refreshes
    // manually on focus, so this is non-fatal.
    return null;
  }
}

// (Re)point the watcher at the current vault — called on launch and whenever the
// vault switches, so we never keep watching the folder we just left.
function rewatch(win: BrowserWindow | null): void {
  vaultWatcher?.close();
  vaultWatcher = null;
  if (win && !win.isDestroyed()) vaultWatcher = startWatch(win);
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: "#1a1b1e",
    title: "KestraVault",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    if (!SMOKE) mainWindow.show();
  });
  if (SMOKE) smokeCheck(mainWindow);

  // Open external links in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Navigation guard: the app frame should only ever load its own UI. A stray
  // or malicious link that tries to navigate the whole window away is cancelled
  // and, if it's a real web URL, handed to the user's browser instead. This is
  // a standard Electron hardening step (defense-in-depth alongside the CSP).
  const appUrl = process.env["ELECTRON_RENDERER_URL"];
  const isInternal = (url: string): boolean => {
    if (appUrl) return url.startsWith(appUrl);
    return url.startsWith("file://");
  };
  const guardNavigation = (e: Electron.Event, url: string): void => {
    if (isInternal(url)) return;
    e.preventDefault();
    if (isExternal(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.on("will-navigate", guardNavigation);
  mainWindow.webContents.on("will-redirect", guardNavigation);
  // Never let the renderer attach a <webview>.
  mainWindow.webContents.on("will-attach-webview", (e) => e.preventDefault());

  rewatch(mainWindow);
  mainWindow.on("closed", () => {
    vaultWatcher?.close();
    vaultWatcher = null;
  });

  // electron-vite injects ELECTRON_RENDERER_URL in dev (the Vite dev server);
  // in a packaged build we load the built HTML from disk.
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(moduleDir, "../renderer/index.html"));
  }
}

void app.whenReady().then(async () => {
  await initVaults();
  registerAppIpc();
  registerUpdateIpc();
  registerVaultIpc();
  registerAiIpc();
  registerSecretIpc();
  registerActivityIpc();
  registerSyncIpc();
  createWindow();
  initSync();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
