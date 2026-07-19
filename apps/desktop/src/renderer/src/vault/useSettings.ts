import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunMode } from "@kestravault/core";
import type { AiProviderConfig, AiProviderKind, EffortLevel } from "@renderer/env";

// ── Settings: the "bring your own model" surface ─────────────────────────────
// KestraVault is open source and free — the AI runs on whatever model the user
// brings. This store holds the chosen provider (+ its key / base URL / model)
// and a few appearance preferences, persisted to localStorage. Per-provider
// fields are kept separately so switching providers never loses a key you typed.

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** How the main process talks to it. */
  kind: AiProviderKind;
  /** Pre-filled endpoint for HTTP providers (editable for custom/local). */
  defaultBaseUrl?: string;
  /** Whether the user must supply an API key. */
  needsKey: boolean;
  /** Runs on the user's machine — copy emphasises privacy + "no key". */
  local?: boolean;
  /** Suggested models; the model field is still free-text for anything else. */
  models: ModelOption[];
  defaultModel: string;
  /** One-line description shown under the provider in Settings. */
  blurb: string;
  /** Where to get a key / set the provider up. */
  setupUrl?: string;
  keyPlaceholder?: string;
}

// The provider catalogue. Four wire "kinds" (subscription / openai-sub /
// anthropic / openai) cover every entry; the OpenAI-compatible kind serves
// cloud and local alike. The `models` lists are curated fallbacks — for API
// providers the app also asks the provider itself what it can serve (live
// discovery via GET /models), so new models show up without an app update.
export const PROVIDERS: ProviderPreset[] = [
  {
    id: "claude-sub",
    label: "Claude (Pro / Max subscription)",
    kind: "subscription",
    needsKey: false,
    models: [
      { id: "sonnet", label: "Sonnet (latest)" },
      { id: "opus", label: "Opus (latest)" },
      { id: "haiku", label: "Haiku (latest)" },
    ],
    defaultModel: "sonnet",
    blurb: "Reuses your Claude.ai login (like Claude Code). No API key — just sign in once.",
  },
  {
    id: "chatgpt-sub",
    label: "ChatGPT (Plus / Pro subscription)",
    kind: "openai-sub",
    needsKey: false,
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ],
    defaultModel: "gpt-5.6-sol",
    blurb: "Reuses your ChatGPT login via the Codex CLI. No API key — sign in once with codex.",
    setupUrl: "https://developers.openai.com/codex/cli",
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    needsKey: true,
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
    ],
    defaultModel: "claude-sonnet-5",
    blurb: "Pay-as-you-go Claude with your own Anthropic API key.",
    setupUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    needsKey: true,
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
    defaultModel: "gpt-5.6-terra",
    blurb: "GPT models with your own OpenAI API key.",
    setupUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    models: [
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    ],
    defaultModel: "anthropic/claude-sonnet-5",
    blurb: "One key, hundreds of models across providers.",
    setupUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    defaultBaseUrl: "http://localhost:11434/v1",
    needsKey: false,
    local: true,
    models: [
      { id: "llama3.3", label: "Llama 3.3" },
      { id: "qwen3", label: "Qwen 3" },
      { id: "gemma3", label: "Gemma 3" },
      { id: "mistral", label: "Mistral" },
    ],
    defaultModel: "llama3.3",
    blurb: "Runs entirely on your machine — private and free. Needs the Ollama app running.",
    setupUrl: "https://ollama.com/download",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "openai",
    defaultBaseUrl: "http://localhost:1234/v1",
    needsKey: false,
    local: true,
    models: [{ id: "local-model", label: "Loaded model" }],
    defaultModel: "local-model",
    blurb: "Local models via LM Studio's server. Start the server, then pick your loaded model.",
    setupUrl: "https://lmstudio.ai",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    defaultBaseUrl: "",
    needsKey: false,
    models: [],
    defaultModel: "",
    blurb: "Any endpoint that speaks the OpenAI /chat/completions protocol.",
  },
];

export const getPreset = (id: string): ProviderPreset =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;

// Secret-store id for the self-host sync server's anon key (mirror of
// main/syncServer.ts). Lives beside the provider ids in the same encrypted
// store; distinct from every provider preset id by construction.
export const SYNC_SERVER_SECRET_ID = "sync-server";

// Per-provider editable fields (kept even while another provider is selected).
// Note: NO apiKey here — keys are never stored in localStorage. They live
// encrypted in the main process (see secrets.ts) and are set/cleared via IPC.
interface ProviderState {
  baseUrl?: string;
  model?: string;
}

/** Theme preference: an explicit choice, or follow the OS. */
export type ThemeMode = "dark" | "light" | "system";

export interface Appearance {
  /** Light, dark, or follow the operating system. */
  theme: ThemeMode;
  /** Editor body font size in px. */
  fontSize: number;
  /** Max editor line width in px (readable line length). */
  lineWidth: number;
  /** Show the live word/character count in the status bar. */
  showWordCount: boolean;
}

interface PersistedSettings {
  /** Provider used by the chat composer. Settings may inspect other providers without changing it. */
  providerId: string;
  /** Model used by chat, deliberately separate from each provider's configured default. */
  chatModel: string;
  byProvider: Record<string, ProviderState>;
  appearance: Appearance;
  /** Reasoning effort for models that support it (see EFFORT_OPTIONS). */
  effort: EffortLevel;
  /** Vault-skill run tier: light/default/deep → Haiku/Sonnet/Opus (routing.ts). */
  runMode: RunMode;
  /** Record note opens/edits/etc. to the local activity log (AI time-awareness). */
  trackActivity: boolean;
  /** Poll GitHub releases for a newer version (notify-only; see main/updates.ts). */
  checkUpdates: boolean;
  /** Self-host sync server URL ("" = none; see selfhost/README.md). */
  syncServerUrl: string;
}

export const LINE_WIDTHS: { id: number; label: string }[] = [
  { id: 640, label: "Narrow" },
  { id: 740, label: "Default" },
  { id: 900, label: "Wide" },
  { id: 100000, label: "Full width" },
];

export const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

// How hard supported models think before replying. "high" preserves the
// existing default; dial down for faster, less expensive answers.
export const EFFORT_OPTIONS: { id: EffortLevel; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

// Valid run tiers, for validating persisted state (mirrors core's RunMode).
const RUN_MODE_VALUES: RunMode[] = ["light", "default", "deep"];

const DEFAULTS: PersistedSettings = {
  providerId: "claude-sub",
  chatModel: "sonnet",
  byProvider: {},
  appearance: { theme: "dark", fontSize: 16, lineWidth: 740, showWordCount: true },
  effort: "high",
  runMode: "default",
  trackActivity: true,
  checkUpdates: true,
  syncServerUrl: "",
};

const STORAGE_KEY = "kestravault.settings.v1";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** What the OS currently prefers. */
function systemTheme(): "dark" | "light" {
  return typeof window !== "undefined" && window.matchMedia?.(LIGHT_QUERY).matches
    ? "light"
    : "dark";
}

/** Collapse a {@link ThemeMode} to the concrete theme to paint. */
function resolveTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? systemTheme() : mode;
}

/**
 * Paint the persisted theme onto <html> before React mounts, so the first frame
 * is already the right colour (no dark-then-light flash). The CSP forbids inline
 * scripts in index.html, so the renderer entry calls this instead.
 */
export function applyStoredTheme(): void {
  let mode: ThemeMode = DEFAULTS.appearance.theme;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedSettings>) : null;
    if (parsed?.appearance?.theme) mode = parsed.appearance.theme;
  } catch {
    /* fall back to the default theme */
  }
  document.documentElement.dataset.theme = resolveTheme(mode);
}

// Older builds stored API keys in plaintext inside byProvider[id].apiKey. On
// load we strip those out (so they're never re-persisted) and hand them back for
// a one-time migration into encrypted storage.
function load(): { settings: PersistedSettings; legacyKeys: Record<string, string> } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      const rawByProvider = (parsed.byProvider ?? {}) as Record<
        string,
        ProviderState & { apiKey?: string }
      >;
      const byProvider: Record<string, ProviderState> = {};
      const legacyKeys: Record<string, string> = {};
      for (const [id, ps] of Object.entries(rawByProvider)) {
        const { apiKey, ...rest } = ps ?? {};
        // Older builds offered an empty Codex default and a generic GPT-5.6
        // alias. Both now migrate to the explicit Sol variant.
        if (id === "chatgpt-sub" && (!rest.model || rest.model === "gpt-5.6")) {
          rest.model = "gpt-5.6-sol";
        }
        if (id === "openai" && rest.model === "gpt-5.6") rest.model = "gpt-5.6-sol";
        byProvider[id] = rest;
        if (apiKey) legacyKeys[id] = apiKey;
      }
      return {
        settings: {
          providerId: getPreset(parsed.providerId ?? "").id,
          chatModel:
            typeof parsed.chatModel === "string"
              ? parsed.chatModel
              : (byProvider[getPreset(parsed.providerId ?? "").id]?.model ??
                getPreset(parsed.providerId ?? "").defaultModel),
          byProvider,
          appearance: { ...DEFAULTS.appearance, ...(parsed.appearance ?? {}) },
          effort: EFFORT_OPTIONS.some((o) => o.id === parsed.effort)
            ? (parsed.effort as EffortLevel)
            : DEFAULTS.effort,
          runMode: RUN_MODE_VALUES.includes(parsed.runMode as RunMode)
            ? (parsed.runMode as RunMode)
            : DEFAULTS.runMode,
          trackActivity: parsed.trackActivity ?? DEFAULTS.trackActivity,
          checkUpdates: parsed.checkUpdates ?? DEFAULTS.checkUpdates,
          syncServerUrl:
            typeof parsed.syncServerUrl === "string"
              ? parsed.syncServerUrl
              : DEFAULTS.syncServerUrl,
        },
        legacyKeys,
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { settings: DEFAULTS, legacyKeys: {} };
}

export function useSettings() {
  // Capture the initial load once (also yields legacy keys to migrate).
  const initial = useRef<ReturnType<typeof load>>();
  if (!initial.current) initial.current = load();
  const [state, setState] = useState<PersistedSettings>(initial.current.settings);

  // Provider ids with a key saved in encrypted storage, plus a version that
  // bumps on every key change so status probes re-evaluate against the new key.
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [keyVersion, setKeyVersion] = useState(0);
  // null until we've asked the main process; false → no OS keychain (warn user).
  const [encAvailable, setEncAvailable] = useState<boolean | null>(null);

  // One-time on mount: migrate any legacy plaintext keys into encrypted storage,
  // then load which providers have a key and whether encryption is available.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const legacy = initial.current!.legacyKeys;
      const ids = Object.keys(legacy);
      if (ids.length) {
        await Promise.all(ids.map((id) => window.api.secret.set(id, legacy[id]!)));
        initial.current!.legacyKeys = {};
      }
      const [list, available] = await Promise.all([
        window.api.secret.list(),
        window.api.secret.available(),
      ]);
      if (!alive) return;
      setSavedKeys(new Set(list));
      setEncAvailable(available);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Persist appearance + provider choice (never keys) to localStorage.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* best-effort */
    }
  }, [state]);

  // Apply appearance to the document: the editor theme + note head read these
  // CSS variables (see styles.css / livePreview.ts), so changes are instant.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--editor-font-size", `${state.appearance.fontSize}px`);
    root.setProperty("--editor-line-width", `${state.appearance.lineWidth}px`);
  }, [state.appearance.fontSize, state.appearance.lineWidth]);

  // Track the OS colour preference so the "System" theme stays live (e.g. the
  // user flips macOS to dark at sunset) without a reload.
  const [systemPref, setSystemPref] = useState<"dark" | "light">(systemTheme);
  useEffect(() => {
    const mq = window.matchMedia(LIGHT_QUERY);
    const onChange = (): void => setSystemPref(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // The concrete theme to paint. Drives the `data-theme` attribute on <html>;
  // styles.css swaps the whole monochrome token set off that attribute.
  const resolvedTheme: "dark" | "light" =
    state.appearance.theme === "system" ? systemPref : state.appearance.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const preset = useMemo(() => getPreset(state.providerId), [state.providerId]);
  const ps = state.byProvider[state.providerId] ?? {};

  // Chat owns its provider/model selection. Provider settings are configuration
  // records and can be browsed or edited without changing an open conversation.
  const model = state.chatModel || preset.defaultModel;
  const baseUrl = ps.baseUrl ?? preset.defaultBaseUrl ?? "";
  // Whether the current provider has a key saved (renderer never sees its value).
  const hasKey = savedKeys.has(state.providerId);

  // The wire config handed to the main process for each AI call/probe. No key:
  // the main process resolves it from encrypted storage by providerId.
  const aiConfig: AiProviderConfig = useMemo(() => {
    if (preset.kind === "subscription") return { kind: "subscription" };
    if (preset.kind === "openai-sub") return { kind: "openai-sub" };
    return { kind: preset.kind, providerId: preset.id, baseUrl };
  }, [preset.kind, preset.id, baseUrl]);

  // Live model discovery: for API providers, ask the endpoint what it can
  // serve right now (GET /models), so brand-new models appear without an app
  // update. Curated preset lists remain the fallback (and the whole list for
  // subscription providers, whose aliases track the newest models anyway).
  const [liveModels, setLiveModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let alive = true;
    setLiveModels([]);
    if (aiConfig.kind === "subscription" || aiConfig.kind === "openai-sub") return;
    void window.api.ai
      .models(aiConfig)
      .then((list) => {
        if (alive) setLiveModels(list.slice(0, 25));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [aiConfig, keyVersion]);

  // What the pickers offer: live list when discovery worked, curated otherwise.
  const models = liveModels.length ? liveModels : preset.models;

  // Effort is model-specific rather than a blanket provider capability.
  // Claude Haiku rejects output_config.effort; OpenAI exposes reasoning_effort
  // on its reasoning families. OpenRouter forwards the equivalent setting for
  // those same OpenAI models.
  const supportsEffort = useMemo(() => {
    if (preset.kind === "subscription" || preset.kind === "anthropic") {
      return !/haiku/i.test(model);
    }
    if (preset.kind === "openai-sub") return true;
    if (preset.kind !== "openai") return false;
    const providerModel = model.replace(/^openai\//i, "");
    const reasoningModel = /^(gpt-5|o\d)/i.test(providerModel);
    return reasoningModel && (preset.id === "openai" || preset.id === "openrouter");
  }, [model, preset.id, preset.kind]);

  const setProviderFieldFor = useCallback(
    (providerId: string, field: keyof ProviderState, value: string) => {
      setState((s) => {
        const id = getPreset(providerId).id;
        const cur = s.byProvider[id] ?? {};
        return {
          ...s,
          byProvider: { ...s.byProvider, [id]: { ...cur, [field]: value } },
        };
      });
    },
    [],
  );

  /** Switch provider and model as one composer action, avoiding an intermediate stale selection. */
  const setProviderModel = useCallback((providerId: string, model: string) => {
    setState((s) => {
      const id = getPreset(providerId).id;
      const cur = s.byProvider[id] ?? {};
      return {
        ...s,
        providerId: id,
        chatModel: model || cur.model || getPreset(id).defaultModel,
      };
    });
  }, []);

  // Save (non-empty) or clear (empty) a provider's key. Round-trips to
  // the main process; the plaintext key never lands in React state or storage.
  const setKeyFor = useCallback(async (providerId: string, key: string): Promise<void> => {
    const id = getPreset(providerId).id;
    await window.api.secret.set(id, key);
    setSavedKeys((prev) => {
      const next = new Set(prev);
      if (key.trim()) next.add(id);
      else next.delete(id);
      return next;
    });
    setKeyVersion((v) => v + 1);
  }, []);

  const providerDetails = useCallback(
    (providerId: string) => {
      const selectedPreset = getPreset(providerId);
      const selectedState = state.byProvider[selectedPreset.id] ?? {};
      return {
        preset: selectedPreset,
        model: selectedState.model || selectedPreset.defaultModel,
        baseUrl: selectedState.baseUrl ?? selectedPreset.defaultBaseUrl ?? "",
        hasKey: savedKeys.has(selectedPreset.id),
        models: selectedPreset.id === state.providerId ? models : selectedPreset.models,
      };
    },
    [models, savedKeys, state.byProvider, state.providerId],
  );

  const providerConfig = useCallback(
    (providerId: string): AiProviderConfig => {
      const details = providerDetails(providerId);
      if (details.preset.kind === "subscription") return { kind: "subscription" };
      if (details.preset.kind === "openai-sub") return { kind: "openai-sub" };
      return {
        kind: details.preset.kind,
        providerId: details.preset.id,
        baseUrl: details.baseUrl,
      };
    },
    [providerDetails],
  );

  // ── Self-host sync server ──
  // The URL persists with the rest of the settings; the anon key rides the
  // same encrypted secret store as provider keys, under its own id.
  const syncServerUrl = state.syncServerUrl;
  const hasSyncKey = savedKeys.has(SYNC_SERVER_SECRET_ID);

  const setSyncServerUrl = useCallback((url: string) => {
    setState((s) => ({ ...s, syncServerUrl: url }));
  }, []);

  const setSyncKey = useCallback(async (key: string): Promise<void> => {
    await window.api.secret.set(SYNC_SERVER_SECRET_ID, key);
    setSavedKeys((prev) => {
      const next = new Set(prev);
      if (key.trim()) next.add(SYNC_SERVER_SECRET_ID);
      else next.delete(SYNC_SERVER_SECRET_ID);
      return next;
    });
    setKeyVersion((v) => v + 1);
  }, []);

  const clearSyncKey = useCallback((): Promise<void> => setSyncKey(""), [setSyncKey]);

  const setAppearance = useCallback((patch: Partial<Appearance>) => {
    setState((s) => ({ ...s, appearance: { ...s.appearance, ...patch } }));
  }, []);

  const setEffort = useCallback((effort: EffortLevel) => {
    setState((s) => ({ ...s, effort }));
  }, []);

  const setRunMode = useCallback((runMode: RunMode) => {
    setState((s) => ({ ...s, runMode }));
  }, []);

  const setTrackActivity = useCallback((on: boolean) => {
    setState((s) => ({ ...s, trackActivity: on }));
  }, []);

  const setCheckUpdates = useCallback((on: boolean) => {
    setState((s) => ({ ...s, checkUpdates: on }));
  }, []);

  return {
    providerId: state.providerId,
    preset,
    model,
    /** Model options for the active provider (live discovery, curated fallback). */
    models,
    baseUrl,
    hasKey,
    /** Provider ids with a credential in the encrypted secret store. */
    keyedProviderIds: Array.from(savedKeys),
    /** null = not yet known; false = stored unencrypted (no OS keychain). */
    encryptionAvailable: encAvailable,
    /** Bumps on every key change — fold into status-invalidation deps. */
    keyVersion,
    appearance: state.appearance,
    /** The concrete theme currently painted ("dark" | "light"), system resolved. */
    resolvedTheme,
    /** Whether note activity is recorded to the local log (AI time-awareness). */
    trackActivity: state.trackActivity,
    /** Whether the app polls GitHub releases for a newer version. */
    checkUpdates: state.checkUpdates,
    aiConfig,
    /** Reasoning effort passed with each request when the model supports it. */
    effort: state.effort,
    /** Whether the active provider/model combination honours effort. */
    supportsEffort,
    /** Vault-skill run tier (light/default/deep); routed to a model in routing.ts. */
    runMode: state.runMode,
    /** Self-host sync server URL ("" = not configured). */
    syncServerUrl,
    /** Whether an anon key is saved for the sync server. */
    hasSyncKey,
    setProviderModel,
    providerDetails,
    providerConfig,
    setProviderFieldFor,
    setKeyFor,
    setSyncServerUrl,
    setSyncKey,
    clearSyncKey,
    setAppearance,
    setEffort,
    setRunMode,
    setTrackActivity,
    setCheckUpdates,
  };
}

export type SettingsController = ReturnType<typeof useSettings>;
