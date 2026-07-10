import { useCallback, useEffect, useState } from "react";
import { AiIcon } from "@renderer/components/AiIcons";
import { Sparkles, Sun, Info, Activity, RefreshCw, Brain } from "lucide-react";
import { INSTRUCTIONS_PATH } from "@renderer/vault/brain";
import type {
  ActivitySummary,
  MemberSummary,
  SyncAccount,
  SyncConfigInfo,
  SyncStatusInfo,
  SyncTestResult,
  WorkspaceSummary,
} from "@renderer/env";
import {
  PROVIDERS,
  LINE_WIDTHS,
  THEME_OPTIONS,
  type SettingsController,
} from "@renderer/vault/useSettings";
import type { AiController } from "@renderer/vault/useAi";

export type SettingsTab = "ai" | "brain" | "sync" | "appearance" | "activity" | "about";

interface SettingsProps {
  settings: SettingsController;
  ai: AiController;
  vaultName: string;
  onReveal: () => void;
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Re-run the onboarding wizard ("Set up my brain"). */
  onBrainSetup?: () => void;
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI model", icon: <SparkGlyph /> },
  { id: "brain", label: "Brain", icon: <BrainGlyph /> },
  { id: "sync", label: "Sync & sharing", icon: <SyncGlyph /> },
  { id: "appearance", label: "Appearance", icon: <SunGlyph /> },
  { id: "activity", label: "Activity", icon: <ActivityGlyph /> },
  { id: "about", label: "About", icon: <InfoGlyph /> },
];

// KestraVault' own inspiration — documented in plan/README.md.
const INSPIRATION_URL = "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f";

// Obsidian/Notion-style settings: a category rail on the left, a scrolling
// content pane on the right. Lives as a modal over the workbench.
export function Settings({
  settings,
  ai,
  vaultName,
  onReveal,
  onClose,
  initialTab,
  onBrainSetup,
}: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "ai");

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay settings-overlay" onClick={onClose}>
      <div
        className="settings"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-nav-item${tab === t.id ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="settings-nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <button className="settings-close icon-btn" title="Close (Esc)" onClick={onClose}>
            <AiIcon name="close" />
          </button>
          {tab === "ai" ? (
            <AiSettings settings={settings} ai={ai} />
          ) : tab === "brain" ? (
            <BrainSettings onBrainSetup={onBrainSetup} onClose={onClose} />
          ) : tab === "sync" ? (
            <SyncSettings vaultName={vaultName} />
          ) : tab === "appearance" ? (
            <AppearanceSettings settings={settings} />
          ) : tab === "activity" ? (
            <ActivitySettings settings={settings} />
          ) : (
            <AboutSettings settings={settings} vaultName={vaultName} onReveal={onReveal} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── AI model ─────────────────────────────────────────────────────────────────

type TestState = { kind: "idle" | "testing" } | { kind: "ok" } | { kind: "fail"; detail: string };

function AiSettings({ settings, ai }: { settings: SettingsController; ai: AiController }) {
  const {
    preset,
    providerId,
    model,
    baseUrl,
    hasKey,
    keyVersion,
    encryptionAvailable,
    setProvider,
    setProviderField,
    setKey,
    clearKey,
  } = settings;
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  // Reset the inline test result + key draft whenever the provider changes, and
  // re-test whenever the saved key changes (keyVersion bumps on save/clear).
  useEffect(() => setKeyDraft(""), [providerId]);
  useEffect(() => setTest({ kind: "idle" }), [providerId, model, baseUrl, keyVersion]);

  async function saveKey(): Promise<void> {
    setSavingKey(true);
    try {
      await setKey(keyDraft);
      setKeyDraft("");
    } finally {
      setSavingKey(false);
    }
  }

  async function runTest(): Promise<void> {
    // Persist a typed-but-unsaved key first, so "Test" checks what you see.
    if (keyDraft.trim()) await saveKey();
    setTest({ kind: "testing" });
    const status = await ai.recheck();
    if (status.connected) setTest({ kind: "ok" });
    else setTest({ kind: "fail", detail: status.detail ?? "Couldn't connect." });
  }

  const isSub = preset.kind === "subscription";

  return (
    <section className="settings-section">
      <h2 className="settings-h">AI model</h2>
      <p className="settings-lead">
        KestraVault is <strong>bring-your-own-model</strong>. Choose where the AI runs — your Claude
        subscription, an API key, or a model on your own machine. KestraVault has no servers of its own;
        keys are <strong>encrypted with your operating-system keychain</strong> and only ever sent
        to the provider you pick.
      </p>

      <div className="provider-grid">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={`provider-card${providerId === p.id ? " is-active" : ""}`}
            onClick={() => setProvider(p.id)}
          >
            <div className="provider-card-head">
              <span className="provider-name">{p.label}</span>
              <span className={`provider-tag${p.local ? " is-local" : ""}`}>
                {p.kind === "subscription" ? "No key" : p.local ? "Local" : "API key"}
              </span>
            </div>
            <span className="provider-blurb">{p.blurb}</span>
          </button>
        ))}
      </div>

      <div className="settings-fields">
        {isSub ? (
          <div className="field-note">
            <p>
              Sign in once, the way Claude Code does: open a terminal, run <code>claude</code>, type{" "}
              <code>/login</code>, and choose <em>“Claude account with subscription.”</em> No API
              key needed.
            </p>
          </div>
        ) : (
          <>
            {preset.needsKey || !preset.local ? (
              <label className="field">
                <span className="field-label">
                  API key
                  {hasKey ? <span className="field-saved">✓ Saved</span> : null}
                  {preset.setupUrl ? (
                    <a
                      className="field-link"
                      href={preset.setupUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get a key →
                    </a>
                  ) : null}
                </span>
                <div className="field-key">
                  <input
                    className="field-input"
                    type={showKey ? "text" : "password"}
                    value={keyDraft}
                    placeholder={
                      hasKey
                        ? "Saved — type a new key to replace"
                        : (preset.keyPlaceholder ?? (preset.local ? "(optional)" : "sk-…"))
                    }
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && keyDraft.trim()) void saveKey();
                    }}
                  />
                  <button
                    type="button"
                    className="field-eye"
                    onClick={() => setShowKey((v) => !v)}
                    title={showKey ? "Hide" : "Show"}
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="field-key-actions">
                  <button
                    type="button"
                    className="ai-btn-ghost"
                    disabled={!keyDraft.trim() || savingKey}
                    onClick={() => void saveKey()}
                  >
                    {savingKey ? "Saving…" : hasKey ? "Replace key" : "Save key"}
                  </button>
                  {hasKey ? (
                    <button type="button" className="ai-btn-ghost" onClick={() => void clearKey()}>
                      Clear
                    </button>
                  ) : null}
                </div>
                {encryptionAvailable === false ? (
                  <span className="field-hint field-warn">
                    No system keychain found — your key is saved to a permission-restricted file on
                    this device instead of the OS keychain.
                  </span>
                ) : null}
              </label>
            ) : null}

            <label className="field">
              <span className="field-label">Base URL</span>
              <input
                className="field-input"
                type="text"
                value={baseUrl}
                placeholder={preset.defaultBaseUrl || "https://…/v1"}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setProviderField("baseUrl", e.target.value)}
              />
            </label>
          </>
        )}

        <label className="field">
          <span className="field-label">Model</span>
          <input
            className="field-input"
            type="text"
            list={`models-${preset.id}`}
            value={model}
            placeholder={preset.defaultModel || "model id"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setProviderField("model", e.target.value)}
          />
          <datalist id={`models-${preset.id}`}>
            {preset.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          {preset.models.length ? (
            <div className="model-chips">
              {preset.models.map((m) => (
                <button
                  key={m.id}
                  className={`model-chip${model === m.id ? " is-active" : ""}`}
                  onClick={() => setProviderField("model", m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          ) : null}
        </label>

        {preset.local ? (
          <div className="field-note is-privacy">
            <p>
              Private by design — with a local model your notes never leave this computer. Make sure
              the local server is running before you test.
            </p>
          </div>
        ) : null}

        <div className="settings-actions">
          <button
            className="ai-btn-primary"
            onClick={() => void runTest()}
            disabled={test.kind === "testing"}
          >
            {test.kind === "testing" ? "Testing…" : "Test connection"}
          </button>
          {test.kind === "ok" ? <span className="test-ok">✓ Connected</span> : null}
          {test.kind === "fail" ? <span className="test-fail">{test.detail}</span> : null}
        </div>
      </div>
    </section>
  );
}

// ── Brain (the AI's standing instructions) ──────────────────────────────────
// Edits `.kestravault/instructions.md` — the plain-language master schema the
// AI reads on every chat and vault operation (written by onboarding, injected
// as the system prompt's vault section). This is the "plain-language
// instructions editor" from the roadmap: no hidden prompt, full control.

function BrainSettings({
  onBrainSetup,
  onClose,
}: {
  onBrainSetup?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const content = await window.api.vault.read(INSTRUCTIONS_PATH);
        setText(content);
        setSaved(content);
      } catch {
        setText(null); // no instructions yet — offer setup instead
        setSaved(null);
      }
    })();
  }, []);

  const dirty = text !== null && text !== saved;

  async function save(): Promise<void> {
    if (text === null) return;
    setError(null);
    try {
      await window.api.vault.write(INSTRUCTIONS_PATH, text);
      setSaved(text);
      setNotice("Saved — the AI follows the new instructions from the next request on.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-h">Brain</h2>
      <p className="settings-lead">
        These are the standing instructions your AI reads before every answer and every vault
        operation — what this vault is for, how pages are organized, and the voice it should
        write in. Plain language; edit them like any note.
      </p>

      {error ? <div className="field-note field-warn"><p>{error}</p></div> : null}
      {notice && !dirty ? <div className="field-note"><p>{notice}</p></div> : null}

      {text === null ? (
        <div className="settings-fields">
          <div className="field-note">
            <p>
              This vault has no instructions yet. Run the setup wizard to create them — it asks a
              few questions and writes <code>.kestravault/instructions.md</code> for you.
            </p>
          </div>
          {onBrainSetup ? (
            <div className="field-key-actions">
              <button
                className="ai-btn-primary"
                onClick={() => {
                  onClose();
                  onBrainSetup();
                }}
              >
                Set up my brain
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="settings-fields">
          <textarea
            className="brain-editor"
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setNotice(null);
            }}
          />
          <div className="field-key-actions">
            <button className="ai-btn-primary" disabled={!dirty} onClick={() => void save()}>
              {dirty ? "Save instructions" : "Saved"}
            </button>
            {dirty ? (
              <button className="ai-btn-ghost" onClick={() => setText(saved)}>
                Discard changes
              </button>
            ) : null}
            {onBrainSetup ? (
              <button
                className="ai-btn-ghost"
                onClick={() => {
                  onClose();
                  onBrainSetup();
                }}
              >
                Re-run setup wizard…
              </button>
            ) : null}
          </div>
          <div className="field-note">
            <p>
              Stored at <code>.kestravault/instructions.md</code> in your vault — synced with it,
              and readable by Claude Code or any other agent you point at the folder.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Sync & sharing ───────────────────────────────────────────────────────────
// Cloud sync (KestraVault Cloud or a self-hosted Supabase) + shared workspaces.
// The model: the OWNER's paid plan covers hosting/sync for up to 3 cloud
// vaults; invited members join free and bring their own AI key (the AI-model
// tab). Self-hosting bypasses billing entirely — open core.

const SELF_HOST_GUIDE_URL = "https://github.com/RyanTL/kestravault/blob/main/selfhost/README.md";

const SERVICE_LABELS: Record<string, string> = {
  auth: "Auth",
  rest: "Database",
  storage: "Storage",
};

type SyncTestState = { kind: "idle" | "testing" } | { kind: "done"; result: SyncTestResult };

function SyncSettings({ vaultName }: { vaultName: string }) {
  const [config, setConfig] = useState<SyncConfigInfo | null>(null);
  const [account, setAccount] = useState<SyncAccount | null>(null);
  const [status, setStatus] = useState<SyncStatusInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Drafts
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selfUrl, setSelfUrl] = useState("");
  const [selfKey, setSelfKey] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [test, setTest] = useState<SyncTestState>({ kind: "idle" });

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [cfg, acct, st] = await Promise.all([
        window.api.sync.getConfig(),
        window.api.sync.account(),
        window.api.sync.status(),
      ]);
      setConfig(cfg);
      setAccount(acct);
      setStatus(st);
      setSelfUrl((prev) => prev || cfg.selfHostUrl);
      if (acct) {
        const list = await window.api.sync.workspaces();
        setWorkspaces(list);
        if (st.workspaceId) {
          setMembers(await window.api.collab.members(st.workspaceId));
        } else {
          setMembers([]);
        }
      } else {
        setWorkspaces([]);
        setMembers([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.api.sync.onStatus((st) => setStatus(st));
  }, [refresh]);

  // Wrap an async action with busy/error handling.
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const linked = status?.workspaceId ?? null;
  const linkedWorkspace = workspaces.find((w) => w.id === linked) ?? null;
  const isOwner = linkedWorkspace?.role === "owner";

  return (
    <section className="settings-section">
      <h2 className="settings-h">Sync &amp; sharing</h2>
      <p className="settings-lead">
        Keep this vault synchronized across your devices — and share it with up to{" "}
        <strong>3 other people</strong> who edit the same notes. Hosting and sync are covered by the{" "}
        <strong>vault owner's cloud plan</strong> (one plan covers up to 3 vaults); everyone brings
        their own AI from the “AI model” tab. Prefer full control? Point the app at your own
        self-hosted server — the entire backend is open source.
      </p>

      {error ? <div className="field-note field-warn"><p>{error}</p></div> : null}
      {notice ? <div className="field-note"><p>{notice}</p></div> : null}

      {/* ── Server ── */}
      <div className="settings-fields">
        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Server</span>
            <span className="field-hint">
              {config?.mode === "self-hosted"
                ? "Your own Supabase instance."
                : config?.hostedAvailable
                  ? "KestraVault Cloud."
                  : "KestraVault Cloud isn't configured in this build — use self-hosting below."}
            </span>
          </div>
          <div className="seg">
            {(["hosted", "self-hosted"] as const).map((m) => (
              <button
                key={m}
                className={`seg-btn${config?.mode === m ? " is-active" : ""}`}
                onClick={() => void run(async () => void (await window.api.sync.setConfig({ mode: m })))}
              >
                {m === "hosted" ? "Cloud" : "Self-hosted"}
              </button>
            ))}
          </div>
        </div>

        {config?.mode === "self-hosted" ? (
          <>
            <div className="field-note">
              <p>
                Run the whole KestraVault backend on your own hardware — the entire stack is open
                source.{" "}
                <a href={SELF_HOST_GUIDE_URL} target="_blank" rel="noreferrer" className="field-link">
                  Self-hosting guide →
                </a>
              </p>
            </div>
            <label className="field">
              <span className="field-label">Server URL</span>
              <input
                className="field-input"
                type="text"
                value={selfUrl}
                placeholder="https://your-project.supabase.co"
                spellCheck={false}
                onChange={(e) => {
                  setSelfUrl(e.target.value);
                  setTest({ kind: "idle" });
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">
                Anon key{config?.hasSelfHostKey ? <span className="field-saved">✓ Saved</span> : null}
              </span>
              <input
                className="field-input"
                type="password"
                value={selfKey}
                placeholder={config?.hasSelfHostKey ? "Saved — paste to replace" : "eyJ…"}
                spellCheck={false}
                onChange={(e) => setSelfKey(e.target.value)}
              />
            </label>
            <div className="field-key-actions">
              <button
                className="ai-btn-ghost"
                disabled={busy || !selfUrl.trim()}
                onClick={() =>
                  void run(async () => {
                    await window.api.sync.setConfig({
                      mode: "self-hosted",
                      selfHostUrl: selfUrl,
                      ...(selfKey.trim() ? { selfHostKey: selfKey } : {}),
                    });
                    setSelfKey("");
                    setNotice("Self-hosted server saved.");
                  })
                }
              >
                Save server
              </button>
              <button
                className="ai-btn-ghost"
                disabled={test.kind === "testing" || !selfUrl.trim()}
                onClick={() =>
                  void (async () => {
                    // Test what you see: persist a typed-but-unsaved key first.
                    if (selfKey.trim()) {
                      await window.api.sync.setConfig({
                        mode: "self-hosted",
                        selfHostUrl: selfUrl,
                        selfHostKey: selfKey,
                      });
                      setSelfKey("");
                      await refresh();
                    }
                    setTest({ kind: "testing" });
                    setTest({ kind: "done", result: await window.api.sync.test(selfUrl) });
                  })()
                }
              >
                {test.kind === "testing" ? "Testing…" : "Test connection"}
              </button>
            </div>
            {test.kind === "done" ? (
              test.result.ok ? (
                <span className="test-ok">✓ Connected — all services healthy</span>
              ) : (
                <span className="test-fail">
                  {test.result.detail ??
                    test.result.services
                      .filter((s) => !s.ok)
                      .map(
                        (s) => `${SERVICE_LABELS[s.service] ?? s.service}: ${s.detail ?? "failed"}`,
                      )
                      .join(" · ")}
                </span>
              )
            ) : null}
          </>
        ) : null}

        {/* ── Account ── */}
        {config?.configured ? (
          account ? (
            <>
              <div className="field-row">
                <div className="field-row-text">
                  <span className="field-label">{account.email ?? "Signed in"}</span>
                  <span className="field-hint">
                    {account.hasActivePlan
                      ? "Cloud plan active — you can create and share up to 3 vaults."
                      : "No active cloud plan — you can join shared vaults for free; creating or sharing vaults needs a plan, an access code, or self-hosting."}
                  </span>
                </div>
                <button
                  className="ai-btn-ghost"
                  disabled={busy}
                  onClick={() => void run(() => window.api.sync.signOut())}
                >
                  Sign out
                </button>
              </div>
              {!account.hasActivePlan && config.mode === "hosted" ? (
                <>
                  <label className="field">
                    <span className="field-label">Access code</span>
                    <input
                      className="field-input"
                      type="text"
                      value={accessCode}
                      placeholder="KV-XXXX-XXXX-XXXX"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setAccessCode(e.target.value)}
                    />
                  </label>
                  <div className="field-key-actions">
                    <button
                      className="ai-btn-primary"
                      disabled={busy || !accessCode.trim()}
                      onClick={() =>
                        void run(async () => {
                          await window.api.sync.redeemCode(accessCode);
                          setAccessCode("");
                          setNotice("Access code redeemed — your cloud plan is active.");
                        })
                      }
                    >
                      Redeem access code
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  className="field-input"
                  type="email"
                  value={email}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  className="field-input"
                  type="password"
                  value={password}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <div className="field-key-actions">
                <button
                  className="ai-btn-primary"
                  disabled={busy || !email.trim() || !password}
                  onClick={() =>
                    void run(async () => {
                      await window.api.sync.signIn(email.trim(), password);
                      setPassword("");
                    })
                  }
                >
                  Sign in
                </button>
                <button
                  className="ai-btn-ghost"
                  disabled={busy || !email.trim() || !password}
                  onClick={() =>
                    void run(async () => {
                      setNotice(await window.api.sync.signUp(email.trim(), password));
                      setPassword("");
                    })
                  }
                >
                  Create account
                </button>
              </div>
            </>
          )
        ) : null}

        {/* ── This vault ── */}
        {account ? (
          <>
            <div className="field-row">
              <div className="field-row-text">
                <span className="field-label">This vault ({vaultName})</span>
                <span className="field-hint">
                  {linked
                    ? `Synced with “${status?.workspaceName ?? linked}” — ${
                        status?.syncing
                          ? "syncing…"
                          : (status?.lastSummary ?? "waiting for first sync")
                      }${status?.lastError ? ` · ${status.lastError}` : ""}`
                    : "Not synced. Link it to a cloud vault below to sync it everywhere."}
                </span>
              </div>
              {linked ? (
                <div className="field-key-actions">
                  <button
                    className="ai-btn-ghost"
                    disabled={busy || status?.syncing}
                    onClick={() => void run(async () => void (await window.api.sync.now()))}
                  >
                    Sync now
                  </button>
                  <button
                    className="ai-btn-ghost"
                    disabled={busy}
                    onClick={() => void run(() => window.api.sync.unlink())}
                  >
                    Unlink
                  </button>
                </div>
              ) : null}
            </div>

            {status?.conflicts.length ? (
              <div className="field-note field-warn">
                <p>
                  Overlapping edits were kept as <code>*.conflict.md</code> copies next to:{" "}
                  {status.conflicts.join(", ")} — review and merge them by hand.
                </p>
              </div>
            ) : null}

            {!linked ? (
              <>
                {workspaces.map((w) => (
                  <div className="field-row" key={w.id}>
                    <div className="field-row-text">
                      <span className="field-label">{w.name}</span>
                      <span className="field-hint">
                        {w.role === "owner" ? "Your vault" : "Shared with you"}
                      </span>
                    </div>
                    <button
                      className="ai-btn-ghost"
                      disabled={busy}
                      onClick={() => void run(() => window.api.sync.link(w.id, w.name))}
                    >
                      Link
                    </button>
                  </div>
                ))}
                <div className="field-row">
                  <div className="field-row-text">
                    <span className="field-label">Push this vault to the cloud</span>
                    <span className="field-hint">
                      Creates a cloud vault named “{vaultName}” from your current notes and
                      keeps it synced across your devices.
                    </span>
                  </div>
                  <button
                    className="ai-btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const ws = await window.api.sync.createWorkspace(vaultName);
                        await window.api.sync.link(ws.id, ws.name);
                      })
                    }
                  >
                    Create
                  </button>
                </div>
              </>
            ) : null}

            {/* ── Sharing (linked vault only) ── */}
            {linked ? (
              <>
                <div className="field-row">
                  <div className="field-row-text">
                    <span className="field-label">People with access</span>
                    <span className="field-hint">
                      Owner + up to 3 members. Everyone edits the same notes; every edit is
                      attributed.
                    </span>
                  </div>
                </div>
                {members.map((m) => (
                  <div className="field-row" key={m.userId}>
                    <div className="field-row-text">
                      <span className="field-label">
                        {m.email ?? m.userId.slice(0, 8) + "…"}
                        {m.isSelf ? " (you)" : ""}
                      </span>
                      <span className="field-hint">{m.role}</span>
                    </div>
                    {isOwner && !m.isSelf ? (
                      <button
                        className="ai-btn-ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.api.collab.removeMember(linked, m.userId))
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                {isOwner ? (
                  <div className="field-key-actions">
                    <button
                      className="ai-btn-ghost"
                      disabled={busy || members.length >= 4}
                      onClick={() =>
                        void run(async () => {
                          setInviteToken(await window.api.collab.invite(linked, null));
                        })
                      }
                    >
                      Create invite
                    </button>
                    {inviteToken ? (
                      <button
                        className="ai-btn-ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(inviteToken);
                          setNotice("Invite token copied — send it to your collaborator.");
                        }}
                      >
                        Copy invite token
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {/* ── Join a shared vault ── */}
            <div className="field-key">
              <input
                className="field-input"
                type="text"
                value={joinToken}
                placeholder="Paste an invite token to join a shared vault…"
                spellCheck={false}
                onChange={(e) => setJoinToken(e.target.value)}
              />
              <button
                className="ai-btn-ghost"
                disabled={busy || !joinToken.trim()}
                onClick={() =>
                  void run(async () => {
                    await window.api.collab.join(joinToken.trim());
                    setJoinToken("");
                    setNotice("Joined! Link the shared vault above to start syncing.");
                  })
                }
              >
                Join
              </button>
            </div>
          </>
        ) : null}

        <div className="field-note">
          <p>
            Conflicts are rare — edits merge automatically. When two people change the same line,
            the first save wins and the other is kept as a <code>.conflict.md</code> copy, so no
            one's work is ever lost. Deleting is always reversible: files are only soft-deleted in
            the cloud.
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Appearance ───────────────────────────────────────────────────────────────

function AppearanceSettings({ settings }: { settings: SettingsController }) {
  const { appearance, setAppearance } = settings;
  return (
    <section className="settings-section">
      <h2 className="settings-h">Appearance</h2>
      <p className="settings-lead">Tune the reading and writing surface to taste.</p>

      <div className="settings-fields">
        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Theme</span>
            <span className="field-hint">
              Light or dark — or follow your system. Toggle anytime from the title bar.
            </span>
          </div>
          <div className="seg">
            {THEME_OPTIONS.map((t) => (
              <button
                key={t.id}
                className={`seg-btn${appearance.theme === t.id ? " is-active" : ""}`}
                onClick={() => setAppearance({ theme: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Editor font size</span>
            <span className="field-hint">{appearance.fontSize}px</span>
          </div>
          <input
            className="field-range"
            type="range"
            min={12}
            max={22}
            step={1}
            value={appearance.fontSize}
            onChange={(e) => setAppearance({ fontSize: Number(e.target.value) })}
          />
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Readable line length</span>
            <span className="field-hint">How wide a note's text column can grow.</span>
          </div>
          <div className="seg">
            {LINE_WIDTHS.map((w) => (
              <button
                key={w.id}
                className={`seg-btn${appearance.lineWidth === w.id ? " is-active" : ""}`}
                onClick={() => setAppearance({ lineWidth: w.id })}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Word count in status bar</span>
            <span className="field-hint">Show live word + character counts for the open note.</span>
          </div>
          <Toggle
            on={appearance.showWordCount}
            onChange={(v) => setAppearance({ showWordCount: v })}
          />
        </div>
      </div>
    </section>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

function ActivitySettings({ settings }: { settings: SettingsController }) {
  const { trackActivity, setTrackActivity } = settings;
  const [summary, setSummary] = useState<ActivitySummary | null>(null);

  async function refresh(): Promise<void> {
    try {
      setSummary(await window.api.activity.summary());
    } catch {
      /* leave the previous value */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function clear(): Promise<void> {
    if (!window.confirm("Erase your entire activity history? This can't be undone.")) return;
    await window.api.activity.clear();
    await refresh();
  }

  const sinceText = summary?.since
    ? new Date(summary.since).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <section className="settings-section">
      <h2 className="settings-h">Activity</h2>
      <p className="settings-lead">
        KestraVault keeps a <strong>private, on-device</strong> log of what you open and edit so the AI
        can answer questions like <em>“what did I work on yesterday?”</em> and reason about how much
        time is left on your projects. It never leaves your computer, and the contents of your notes
        are never logged.
      </p>

      <div className="settings-fields">
        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Track my activity</span>
            <span className="field-hint">
              Record note opens, edits, and AI questions locally. Turn off to pause.
            </span>
          </div>
          <Toggle on={trackActivity} onChange={setTrackActivity} />
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">History</span>
            <span className="field-hint">
              {summary
                ? summary.total
                  ? `${summary.total.toLocaleString()} events${sinceText ? ` since ${sinceText}` : ""}.`
                  : "No activity recorded yet."
                : "…"}
            </span>
          </div>
          <div className="field-key-actions">
            <button className="ai-btn-ghost" onClick={() => void window.api.activity.reveal()}>
              Reveal log file
            </button>
            <button className="ai-btn-ghost" onClick={() => void clear()}>
              Clear history
            </button>
          </div>
        </div>

        <div className="field-note">
          <p>
            Add a <code>due:</code> date to any note's properties (e.g. <code>due: 2026-07-31</code>
            ) and the AI will track how much time you have left.
          </p>
        </div>
      </div>
    </section>
  );
}

// ── About ────────────────────────────────────────────────────────────────────

function AboutSettings({
  settings,
  vaultName,
  onReveal,
}: {
  settings: SettingsController;
  vaultName: string;
  onReveal: () => void;
}) {
  const { checkUpdates, setCheckUpdates } = settings;
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.api.app
      .version()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="settings-section">
      <h2 className="settings-h">About KestraVault</h2>
      <p className="settings-lead">
        An open-source, AI-first second brain — <strong>free</strong>, and you bring your own model.
        Drop in sources, ask questions, and let an AI keep an interlinked wiki fresh.
      </p>

      <div className="about-badges">
        <span className="about-badge">Open source</span>
        <span className="about-badge">Bring your own model</span>
        <span className="about-badge">Local-first vault</span>
      </div>

      <div className="settings-fields">
        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Version</span>
            <span className="field-hint">
              {version ? `KestraVault ${version}` : "…"} · Electron {window.api.versions.electron}
            </span>
          </div>
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Check for updates</span>
            <span className="field-hint">
              Look for new releases on launch and daily. You'll get a banner with a download link —
              nothing installs itself. Turn off for zero update-related network calls.
            </span>
          </div>
          <Toggle on={checkUpdates} onChange={setCheckUpdates} />
        </div>

        <div className="field-row">
          <div className="field-row-text">
            <span className="field-label">Vault</span>
            <span className="field-hint">
              Your notes are plain markdown files in “{vaultName}”.
            </span>
          </div>
          <button className="ai-btn-ghost" onClick={onReveal}>
            Reveal in Finder
          </button>
        </div>

        <div className="field-note">
          <p>
            KestraVault productizes the “LLM wiki” pattern.{" "}
            <a href={INSPIRATION_URL} target="_blank" rel="noreferrer" className="field-link">
              Read the inspiration →
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Glyphs (stroke, 17px, currentColor — matches the ribbon) ─────────────────

function SparkGlyph() {
  return <Sparkles size={17} strokeWidth={1.8} aria-hidden />;
}

function BrainGlyph() {
  return <Brain size={17} strokeWidth={1.8} aria-hidden />;
}

function SyncGlyph() {
  return <RefreshCw size={17} strokeWidth={1.8} aria-hidden />;
}

function SunGlyph() {
  return <Sun size={17} strokeWidth={1.8} aria-hidden />;
}

function InfoGlyph() {
  return <Info size={17} strokeWidth={1.8} aria-hidden />;
}

function ActivityGlyph() {
  return <Activity size={17} strokeWidth={1.8} aria-hidden />;
}
