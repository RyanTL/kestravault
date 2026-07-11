import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { Ribbon } from "@renderer/components/Ribbon";
import { FileExplorer } from "@renderer/components/FileExplorer";
import { Bookmarks } from "@renderer/components/Bookmarks";
import { EditorGroup } from "@renderer/components/EditorGroup";
import { GraphView } from "@renderer/components/GraphView";
import { RightSidebar } from "@renderer/components/RightSidebar";
import { QuickSwitcher } from "@renderer/components/QuickSwitcher";
import { SearchModal } from "@renderer/components/SearchModal";
import { CommandPalette, type Command } from "@renderer/components/CommandPalette";
import { AIChatPanel } from "@renderer/components/AIChatPanel";
import { Onboarding } from "@renderer/components/Onboarding";
import { Settings, type SettingsTab } from "@renderer/components/Settings";
import { AiAvatar } from "@renderer/components/AiIcons";
import { PanelLeft, PanelRight, Columns2, Moon, Sun, ArrowDownToLine, X } from "lucide-react";
import type { UpdateInfo } from "@renderer/env";
import { useVault } from "@renderer/vault/useVault";
import { useWorkspace } from "@renderer/vault/useWorkspace";
import { useBookmarks } from "@renderer/vault/useBookmarks";
import { useAi, type AiRewrite } from "@renderer/vault/useAi";
import { useChats } from "@renderer/vault/useChats";
import { useSettings } from "@renderer/vault/useSettings";
import { gruntModelFor } from "@renderer/vault/routing";
import { stripFrontmatter } from "@renderer/vault/markdown";
import { baseName, dirName, noteName } from "@renderer/vault/paths";
import { recordActivity, setActivityTracking } from "@renderer/vault/activityLog";
import { readBrainConfig, type BrainProfile } from "@renderer/vault/brain";

type Overlay = "switcher" | "search" | "commands" | null;

function PanelIcon({ side }: { side: "left" | "right" }) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return <Icon size={15} strokeWidth={1.8} aria-hidden />;
}

function SplitIcon() {
  return <Columns2 size={15} strokeWidth={1.8} aria-hidden />;
}

// Reflects the theme currently painted: a moon in dark, a sun in light.
function ThemeIcon({ theme }: { theme: "dark" | "light" }) {
  const Icon = theme === "dark" ? Moon : Sun;
  return <Icon size={15} strokeWidth={1.8} aria-hidden />;
}

// A draggable seam between two panes. Sits as a zero-width flex item straddling
// the border; `onResize` receives the pointer delta in px each move (the caller
// decides the sign + clamping via a functional state update).
function ResizeHandle({ onResize }: { onResize: (dx: number) => void }) {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let last = e.clientX;
        const move = (ev: PointerEvent): void => {
          onResizeRef.current(ev.clientX - last);
          last = ev.clientX;
        };
        const up = (): void => {
          el.releasePointerCapture(e.pointerId);
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          document.body.classList.remove("is-col-resizing");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        document.body.classList.add("is-col-resizing");
      }}
    >
      <span className="resize-grip" />
    </div>
  );
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

// A panel width persisted to localStorage, clamped to a sane range.
function usePanelWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
): [number, (updater: (w: number) => number) => void] {
  const [w, setW] = useState<number>(() => {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? clamp(n, min, max) : initial;
  });
  useEffect(() => {
    localStorage.setItem(key, String(w));
  }, [key, w]);
  const update = useCallback(
    (updater: (w: number) => number) => setW((cur) => clamp(updater(cur), min, max)),
    [min, max],
  );
  return [w, update];
}

export default function App() {
  const vault = useVault();
  const ws = useWorkspace();
  const settings = useSettings();
  // The AI controller reads the active provider config from Settings on every
  // call, so switching providers (key, base URL, model) takes effect at once.
  const ai = useAi(() => settings.aiConfig);
  const chats = useChats();
  const bookmarks = useBookmarks(vault.root);
  // Mirror the "Track my activity" setting into the recorder so opens/edits are
  // only logged while the user has tracking on.
  useEffect(() => setActivityTracking(settings.trackActivity), [settings.trackActivity]);

  // Update notifications: mirror the "Check for updates" setting into the main
  // process (which polls GitHub releases on launch + daily while enabled) and
  // surface the result as a dismissible banner. v1 is notify-only — the button
  // opens the release page in the browser; nothing auto-installs.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => window.api.updates.onAvailable(setUpdate), []);
  useEffect(() => {
    void window.api.updates.setEnabled(settings.checkUpdates);
  }, [settings.checkUpdates]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [leftView, setLeftView] = useState<"files" | "bookmarks">("files");
  const [showRight, setShowRight] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiFull, setAiFull] = useState(false);
  const [aiSeed, setAiSeed] = useState<{ q: string; token: number } | null>(null);
  // A skill invoked from the editor's "/" menu: open the AI panel and run it.
  const [skillSeed, setSkillSeed] = useState<{ id: string; token: number } | null>(null);
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  // The brain onboarding wizard. `profile` prefills a re-run from the vault's
  // saved answers; null = closed.
  const [onboarding, setOnboarding] = useState<{ profile?: BrainProfile } | null>(null);

  // Resizable panels — widths persist across sessions.
  const [leftWidth, setLeftWidth] = usePanelWidth("kestravault.w.left", 250, 180, 520);
  const [rightWidth, setRightWidth] = usePanelWidth("kestravault.w.right", 290, 220, 560);
  const [aiWidth, setAiWidth] = usePanelWidth("kestravault.w.ai", 360, 300, 720);
  const workbenchVars = {
    "--left-w": `${leftWidth}px`,
    "--right-w": `${rightWidth}px`,
    "--ai-w": `${aiWidth}px`,
  } as React.CSSProperties;

  // Full view is a chat-only mode; closing the panel always drops back to the
  // docked side panel so reopening isn't a surprise.
  useEffect(() => {
    if (!showAi) setAiFull(false);
  }, [showAi]);

  // When the AI provider/url/key changes, drop the cached connection status so
  // the next probe (e.g. when the chat panel reopens) re-checks the new target.
  // The key isn't in aiConfig (it lives encrypted in main), so keyVersion — which
  // bumps on every save/clear — stands in for "the key changed".
  const aiConfigSig = `${settings.aiConfig.kind}|${settings.aiConfig.providerId ?? ""}|${
    settings.aiConfig.baseUrl ?? ""
  }|${settings.keyVersion}`;
  useEffect(() => {
    ai.invalidate();
  }, [aiConfigSig]);

  const views = useRef(new Map<string, EditorView | null>());

  const vaultName = useMemo(() => (vault.root ? baseName(vault.root) : "Vault"), [vault.root]);

  // Offer brain onboarding for any vault that hasn't been through it (fresh
  // install, "Create new vault…", or an opened folder). A completed or skipped
  // run writes a marker to .kestravault/config.json, so this fires once per vault;
  // the "Set up my brain" command re-opens it on demand.
  useEffect(() => {
    if (!vault.root) return;
    let alive = true;
    void readBrainConfig().then((cfg) => {
      if (!alive) return;
      if (!cfg) setOnboarding({});
      else setOnboarding(null); // switching vaults closes a stale wizard
    });
    return () => {
      alive = false;
    };
  }, [vault.root]);

  async function openBrainSetup(): Promise<void> {
    const cfg = await readBrainConfig();
    setOnboarding({ profile: cfg?.profile });
  }

  const activePane = ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
  const activePath = activePane?.active ?? null;
  const activeContent = activePath ? (vault.openDocs[activePath]?.content ?? "") : "";
  const activeTitle = activePath ? noteName(activePath) : "";

  // Shared-vault presence: tell the main process which note is active so other
  // members see "you — editing X" (no-op when the vault isn't linked/synced).
  useEffect(() => {
    window.api.collab.setActiveNote(activePath, activePath ? noteName(activePath) : null);
  }, [activePath]);
  // Whether the active AI provider runs on the user's machine (Ollama / LM
  // Studio). When local, nothing leaves the device, so the per-note Private flag
  // is relaxed (full body shared; the toggle's helper text reflects this).
  const aiIsLocal = settings.preset.local === true;

  function askAi(query: string): void {
    setShowAi(true);
    setAiSeed({ q: query, token: Date.now() });
  }

  // Run a vault skill from the editor's "/" menu: reveal the AI
  // panel and hand it the request, which it runs against the active note.
  function askSkill(id: string): void {
    setShowAi(true);
    setSkillSeed({ id, token: Date.now() });
  }

  // A single-shot AI call bound to the active model, for the selection toolbar's
  // inline rewrite. Reuses the same streaming pipeline as the Ask-AI panel.
  const aiRewrite = useCallback<AiRewrite>(
    (system, userText, handlers) =>
      ai.stream(system, [{ role: "user", content: userText }], settings.model, handlers),
    [ai.stream, settings.model],
  );

  function openSettings(tab: SettingsTab = "ai"): void {
    setOverlay(null);
    setSettingsTab(tab);
  }

  // One-click light/dark flip. Resolves "system" to whatever's painted now, then
  // commits the opposite as an explicit choice (Settings keeps a "System" option).
  function toggleTheme(): void {
    settings.setAppearance({ theme: settings.resolvedTheme === "dark" ? "light" : "dark" });
  }

  /** Reveal (expand + scroll to + flash) a folder or note in the file tree. */
  function revealInTree(path: string): void {
    setShowLeft(true);
    setLeftView("files");
    setReveal({ path, nonce: Date.now() });
  }

  // Switch the left sidebar to a view; clicking the view already showing
  // collapses the sidebar (Obsidian's ribbon behaviour).
  function selectLeftView(view: "files" | "bookmarks"): void {
    setShowLeft((open) => !(open && leftView === view));
    setLeftView(view);
  }

  // Open today's daily note (YYYY-MM-DD.md at the vault root), creating it if new.
  function openDailyNote(): void {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    const path = `${stamp}.md`;
    if (vault.files.some((f) => f.path === path)) {
      openFile(path);
    } else {
      void (async () => {
        const created = await vault.createNote("", stamp);
        ws.open(created);
      })();
    }
  }

  // Split the editor, or collapse back to one pane (keeping the focused one).
  const isSplit = ws.panes.length > 1;
  function toggleSplit(): void {
    if (isSplit) {
      const other = ws.panes.find((p) => p.id !== ws.activePaneId);
      if (other) ws.closePane(other.id);
    } else {
      ws.splitRight();
    }
  }

  const counts = useMemo(() => {
    const body = stripFrontmatter(activeContent).trim();
    return { words: body ? body.split(/\s+/).length : 0, chars: activeContent.length };
  }, [activeContent]);

  function openFile(path: string): void {
    setShowGraph(false); // opening a note returns from the graph to the editor
    ws.open(path);
    void vault.loadDoc(path);
    recordActivity({ type: "open", path, title: noteName(path) });
  }

  // Switch the open vault: save pending edits to the current one, clear the
  // workspace (its tabs/panes all point at the old vault), then load the new one.
  // useVault swaps the tree, root, and open-doc state for us.
  function leaveCurrentVault(): void {
    ws.reset();
    setShowGraph(false);
    setOverlay(null);
  }
  async function switchToVault(path: string): Promise<void> {
    await vault.flushAll();
    leaveCurrentVault();
    await vault.switchVault(path);
  }
  async function openVaultFolder(): Promise<void> {
    await vault.flushAll();
    if (await vault.openVaultFolder()) leaveCurrentVault();
  }
  async function createNewVault(): Promise<void> {
    await vault.flushAll();
    if (await vault.createVault()) leaveCurrentVault();
  }

  // Rename a note from its inline title (keeps it in the same folder).
  async function renameNote(path: string, nextName: string): Promise<void> {
    const stem = nextName.replace(/\.md$/i, "").replace(/[/\\]/g, "-").trim();
    if (!stem) return;
    const dir = dirName(path);
    const next = `${dir ? dir + "/" : ""}${stem}.md`;
    if (next === path) return;
    const actual = await vault.rename(path, next);
    ws.remapTab(path, actual);
    bookmarks.remap(path, actual);
  }

  // Move a note into another folder (drag-and-drop in the file tree). Returns
  // the path it actually landed at so the tree can record its new order slot.
  async function moveNote(path: string, targetDir: string): Promise<string> {
    const actual = await vault.move(path, targetDir);
    if (actual !== path) {
      ws.remapTab(path, actual);
      bookmarks.remap(path, actual);
      revealInTree(actual); // flash where it landed
    }
    return actual;
  }

  // Keep open docs in sync with the panes: load anything newly opened, close
  // anything no longer in any pane (which flushes its pending save).
  useEffect(() => {
    for (const p of ws.openPaths) void vault.loadDoc(p);
    for (const path of Object.keys(vault.openDocs)) {
      if (!ws.openPaths.has(path)) void vault.closeDoc(path);
    }
  }, [ws.openPaths]);

  function jumpToLine(line: number): void {
    const view = views.current.get(ws.activePaneId);
    if (!view) return;
    const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
    const pos = view.state.doc.line(clamped).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    view.focus();
  }

  // Stable keyboard handler via a ref so we don't re-subscribe every render.
  const actions = {
    newNote: () =>
      void (async () => {
        const p = await vault.createNote("");
        openFile(p);
      })(),
    toggleOverlay: (o: Exclude<Overlay, null>) => setOverlay((cur) => (cur === o ? null : o)),
    toggleAi: () => setShowAi((v) => !v),
    toggleGraph: () => setShowGraph((v) => !v),
    dailyNote: () => openDailyNote(),
    openSettings: () => openSettings(),
    toggleBookmark: () => {
      if (activePath) bookmarks.toggle(activePath);
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        actionsRef.current.toggleOverlay("switcher");
      } else if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        actionsRef.current.toggleOverlay("commands");
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        actionsRef.current.toggleOverlay("search");
      } else if (key === "j") {
        e.preventDefault();
        actionsRef.current.toggleAi();
      } else if (key === "g" && e.shiftKey) {
        e.preventDefault();
        actionsRef.current.toggleGraph();
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        actionsRef.current.newNote();
      } else if (key === ",") {
        e.preventDefault();
        actionsRef.current.openSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "new-note", title: "New note", hint: "⌘N", run: () => actionsRef.current.newNote() },
      {
        id: "new-folder",
        title: "New folder",
        run: () => void vault.createFolder(""),
      },
      { id: "daily-note", title: "Open today's daily note", run: () => actionsRef.current.dailyNote() },
      { id: "quick-switch", title: "Quick switch to note…", hint: "⌘O", run: () => setOverlay("switcher") },
      { id: "search", title: "Search or ask AI…", hint: "⌘⇧F", run: () => setOverlay("search") },
      { id: "ai", title: showAi ? "Hide AI chat" : "Ask KestraVault AI…", hint: "⌘J", run: () => setShowAi((v) => !v) },
      {
        id: "graph",
        title: showGraph ? "Close graph view" : "Open graph view",
        hint: "⌘⇧G",
        run: () => setShowGraph((v) => !v),
      },
      {
        id: "toggle-left",
        title: showLeft ? "Hide left sidebar" : "Show left sidebar",
        run: () => setShowLeft((v) => !v),
      },
      {
        id: "show-files",
        title: "Show file list",
        run: () => {
          setLeftView("files");
          setShowLeft(true);
        },
      },
      {
        id: "show-bookmarks",
        title: "Show bookmarks",
        run: () => {
          setLeftView("bookmarks");
          setShowLeft(true);
        },
      },
      {
        id: "toggle-right",
        title: showRight ? "Hide outline sidebar" : "Show outline sidebar",
        run: () => setShowRight((v) => !v),
      },
      {
        id: "toggle-theme",
        title: `Switch to ${settings.resolvedTheme === "dark" ? "light" : "dark"} theme`,
        run: () => toggleTheme(),
      },
      { id: "settings", title: "Open settings…", hint: "⌘,", run: () => openSettings("ai") },
      {
        id: "settings-appearance",
        title: "Appearance settings…",
        run: () => openSettings("appearance"),
      },
      {
        id: "brain-setup",
        title: "Set up my vault (onboarding)…",
        run: () => void openBrainSetup(),
      },
      { id: "reveal-vault", title: "Reveal vault in Finder", run: () => void window.api.vault.reveal() },
      { id: "open-vault", title: "Open folder as vault…", run: () => void openVaultFolder() },
      { id: "create-vault", title: "Create new vault…", run: () => void createNewVault() },
    ];
    // One "Switch to vault: X" command per known vault that isn't already open.
    for (const v of vault.vaults) {
      if (v.current) continue;
      list.push({
        id: `switch-vault:${v.path}`,
        title: `Switch to vault: ${v.name}`,
        run: () => void switchToVault(v.path),
      });
    }
    if (ws.panes.length < 2) {
      list.push({ id: "split", title: "Split editor right", run: () => ws.splitRight() });
    } else {
      list.push({ id: "close-pane", title: "Close active pane", run: () => ws.closePane(ws.activePaneId) });
    }
    if (activePath) {
      list.push({
        id: "bookmark",
        title: bookmarks.has(activePath) ? "Remove bookmark" : "Bookmark current note",
        run: () => actionsRef.current.toggleBookmark(),
      });
      list.push({
        id: "close-tab",
        title: "Close current note",
        run: () => ws.closeTab(ws.activePaneId, activePath),
      });
      list.push({
        id: "reveal-note",
        title: "Reveal current note in Finder",
        run: () => void window.api.vault.reveal(activePath),
      });
    }
    return list;
  }, [showLeft, showRight, showAi, showGraph, ws, activePath, vault, bookmarks, settings.resolvedTheme]);

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-spacer" />
        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            title={`Switch to ${settings.resolvedTheme === "dark" ? "light" : "dark"} theme`}
            aria-label="Toggle light/dark theme"
            onClick={toggleTheme}
          >
            <ThemeIcon theme={settings.resolvedTheme} />
          </button>
          <button
            className="titlebar-ai"
            title="Ask KestraVault AI (⌘J)"
            onClick={() => setShowAi((v) => !v)}
          >
            <AiAvatar size={16} />
            <span>Ask AI</span>
          </button>
          <button
            className={`titlebar-btn${isSplit ? " is-on" : ""}`}
            title={isSplit ? "Close split view" : "Split editor right"}
            onClick={toggleSplit}
          >
            <SplitIcon />
          </button>
          <button
            className={`titlebar-btn${showRight ? " is-on" : ""}`}
            title="Toggle outline"
            onClick={() => setShowRight((v) => !v)}
          >
            <PanelIcon side="right" />
          </button>
        </div>
      </div>

      {update && !updateDismissed ? (
        <div className="update-banner" role="status">
          <span className="update-banner-text">
            Update available — KestraVault {update.version} is out.
          </span>
          <a className="update-banner-btn" href={update.url} target="_blank" rel="noreferrer">
            <ArrowDownToLine size={13} strokeWidth={1.8} aria-hidden />
            Download
          </a>
          <button
            className="update-banner-close"
            title="Dismiss"
            aria-label="Dismiss update notice"
            onClick={() => setUpdateDismissed(true)}
          >
            <X size={14} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="workbench" style={workbenchVars}>
        <Ribbon
          leftOpen={showLeft}
          leftView={leftView}
          graphOpen={showGraph}
          onShowFiles={() => selectLeftView("files")}
          onShowBookmarks={() => selectLeftView("bookmarks")}
          onShowGraph={() => setShowGraph((v) => !v)}
          onSearch={() => setOverlay("search")}
          onDailyNote={openDailyNote}
          onCommand={() => setOverlay("commands")}
          onNewNote={() => actionsRef.current.newNote()}
          onOpenSettings={() => openSettings()}
        />

        {!aiFull && showLeft && leftView === "files" ? (
          <FileExplorer
            tree={vault.tree}
            vaultName={vaultName}
            vaults={vault.vaults}
            onSwitchVault={(p) => void switchToVault(p)}
            onOpenVaultFolder={() => void openVaultFolder()}
            onCreateVault={() => void createNewVault()}
            onRemoveVault={(p) => void vault.removeVault(p)}
            selectedPath={activePath}
            revealPath={reveal?.path ?? null}
            revealNonce={reveal?.nonce ?? 0}
            isBookmarked={bookmarks.has}
            onSelect={openFile}
            onCreateNote={async (dir) => {
              const p = await vault.createNote(dir);
              openFile(p);
              return p;
            }}
            onCreateFolder={(dir) => vault.createFolder(dir)}
            onRename={async (p, next) => {
              const actual = await vault.rename(p, next);
              ws.remapTab(p, actual);
              bookmarks.remap(p, actual);
            }}
            onMove={(p, dir) => moveNote(p, dir)}
            onDelete={async (p) => {
              await vault.remove(p);
              ws.dropPath(p);
              bookmarks.remove(p);
            }}
            onToggleBookmark={bookmarks.toggle}
            onSetPrivacy={(path, target, mode) => vault.setPrivacy(path, target, mode)}
            onClearPrivacy={(path, target) => vault.clearPrivacy(path, target)}
            onReveal={(p) => void window.api.vault.reveal(p)}
          />
        ) : null}

        {!aiFull && showLeft && leftView === "bookmarks" ? (
          <Bookmarks
            bookmarks={bookmarks.bookmarks}
            files={vault.files}
            selectedPath={activePath}
            onOpen={openFile}
            onRemove={bookmarks.remove}
          />
        ) : null}

        {!aiFull && showLeft ? (
          <ResizeHandle onResize={(dx) => setLeftWidth((w) => w + dx)} />
        ) : null}

        {!aiFull && showGraph ? (
          <GraphView
            files={vault.files}
            activePath={activePath}
            ai={ai}
            summaryModel={gruntModelFor(settings.preset, settings.model)}
            onOpen={openFile}
            onClose={() => setShowGraph(false)}
          />
        ) : null}

        {!aiFull && !showGraph ? (
          <div className="editor-area">
            {ws.panes.map((pane) => (
              <EditorGroup
                key={pane.id}
                pane={pane}
                isActive={pane.id === ws.activePaneId && ws.panes.length > 1}
                aiIsLocal={aiIsLocal}
                aiRewrite={aiRewrite}
                files={vault.files}
                openDocs={vault.openDocs}
                onChange={vault.editDoc}
                onSetPrivacy={(p, mode) => vault.setPrivacy(p, "file", mode)}
                onClearPrivacy={(p) => vault.clearPrivacy(p, "file")}
                onRename={(p, next) => void renameNote(p, next)}
                onNavigate={revealInTree}
                onOpenWikiLink={(t) => void vault.openWikiLink(t).then((p) => ws.open(p))}
                onFocusPane={() => ws.focusPane(pane.id)}
                onSelectTab={(p) => ws.setActiveTab(pane.id, p)}
                onCloseTab={(p) => ws.closeTab(pane.id, p)}
                onRegisterView={(v) => views.current.set(pane.id, v)}
                onMoveTab={ws.moveTab}
                onRunSkill={askSkill}
              />
            ))}
          </div>
        ) : null}

        {!aiFull && !showGraph && showRight ? (
          <ResizeHandle onResize={(dx) => setRightWidth((w) => w - dx)} />
        ) : null}

        {!aiFull && !showGraph && showRight ? (
          <RightSidebar
            activePath={activePath}
            content={activeContent}
            files={vault.files}
            onOpen={openFile}
            onJump={jumpToLine}
          />
        ) : null}

        {showAi && !aiFull ? (
          <ResizeHandle onResize={(dx) => setAiWidth((w) => w - dx)} />
        ) : null}

        {showAi ? (
          <AIChatPanel
            controller={ai}
            chats={chats}
            activePath={activePath}
            activeTitle={activeTitle}
            activeContent={activeContent}
            files={vault.files}
            onOpenNote={(p) => {
              // Opening a note from chat drops full-screen back to the side
              // panel so the editor is visible beside it.
              setAiFull(false);
              openFile(p);
            }}
            onClose={() => setShowAi(false)}
            full={aiFull}
            onToggleFull={() => setAiFull((v) => !v)}
            model={settings.model}
            models={settings.models}
            onModelChange={(id) => settings.setProviderField("model", id)}
            effort={settings.effort}
            onEffortChange={settings.setEffort}
            supportsEffort={settings.supportsEffort}
            providerLabel={settings.preset.label}
            subscription={
              settings.preset.kind === "subscription"
                ? "claude"
                : settings.preset.kind === "openai-sub"
                  ? "chatgpt"
                  : null
            }
            aiIsLocal={aiIsLocal}
            agentCapable={
              settings.preset.kind === "subscription" || settings.preset.kind === "anthropic"
            }
            preset={settings.preset}
            runMode={settings.runMode}
            onRunModeChange={settings.setRunMode}
            onOpenSettings={() => openSettings("ai")}
            seedQuery={aiSeed?.q}
            seedToken={aiSeed?.token}
            skillReq={skillSeed}
          />
        ) : null}
      </div>

      <footer className="statusbar">
        <span className="statusbar-left">{activePath ?? `${vault.files.length} notes`}</span>
        {activePath && settings.appearance.showWordCount ? (
          <span className="statusbar-right">
            {counts.words} words · {counts.chars} chars
          </span>
        ) : null}
      </footer>

      {overlay === "switcher" ? (
        <QuickSwitcher files={vault.files} onOpen={openFile} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === "search" ? (
        <SearchModal
          files={vault.files}
          onOpen={openFile}
          onAskAI={(q) => {
            setOverlay(null);
            askAi(q);
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "commands" ? (
        <CommandPalette commands={commands} onClose={() => setOverlay(null)} />
      ) : null}
      {settingsTab ? (
        <Settings
          settings={settings}
          ai={ai}
          vaultName={vaultName}
          initialTab={settingsTab}
          onReveal={() => void window.api.vault.reveal()}
          onClose={() => setSettingsTab(null)}
          onBrainSetup={() => void openBrainSetup()}
          onOptimizeVault={() => {
            setSettingsTab(null);
            askSkill("organize");
          }}
        />
      ) : null}
      {onboarding ? (
        <Onboarding
          vaultName={vaultName}
          ai={ai}
          model={settings.model}
          providerLabel={settings.preset.label}
          initialProfile={onboarding.profile}
          onOpenSettings={() => openSettings("ai")}
          onClose={() => {
            // The watcher refreshes the tree, so the new folders are already
            // visible when the wizard closes.
            setOnboarding(null);
          }}
        />
      ) : null}
    </div>
  );
}
