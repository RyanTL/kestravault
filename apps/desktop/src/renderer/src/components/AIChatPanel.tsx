import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@renderer/components/Markdown";
import { AiAvatar, AiIcon } from "@renderer/components/AiIcons";
import { NewNoteIcon } from "@renderer/components/Ribbon";
import type { AiController } from "@renderer/vault/useAi";
import type { ChatsController, ChatSource, ChatTurn } from "@renderer/vault/useChats";
import {
  ASSISTANT_PERSONA,
  ASK_SUGGESTIONS,
  LOCAL_ONLY_PAGE_REFUSAL,
  PAGE_ACTIONS,
  PRIVATE_PAGE_REFUSAL,
  SKILLS_NEED_CLAUDE,
  VAULT_SKILLS,
  type VaultSkill,
  isTemporalQuery,
  notesContext,
  pageContext,
  timeContext,
} from "@renderer/vault/aiPrompts";
import { INSTRUCTIONS_PATH, brainContext } from "@renderer/vault/brain";
import { readCustomSkills, toVaultSkill } from "@renderer/vault/skills";
import { isPrivateNote } from "@renderer/vault/notePrivacy";
import { noteName } from "@renderer/vault/paths";
import { recordActivity } from "@renderer/vault/activityLog";
import { rankNotes } from "@renderer/vault/search";
import { EFFORT_OPTIONS, type ModelOption, type ProviderPreset } from "@renderer/vault/useSettings";
import { RUN_MODES, agentModelFor, isRoutable } from "@renderer/vault/routing";
import {
  remoteAiAccessForPrivacy,
  type EffectivePrivacy,
  type PrivacyMode,
  type RunMode,
} from "@kestravault/core";
import type { EffortLevel } from "@renderer/env";

interface AIChatPanelProps {
  controller: AiController;
  chats: ChatsController;
  activePath: string | null;
  activeTitle: string;
  activeContent: string;
  files: { name: string; path: string; privacy?: EffectivePrivacy }[];
  onOpenNote: (path: string) => void;
  onClose: () => void;
  full: boolean;
  onToggleFull: () => void;
  /** Current model + the suggestions for the active provider (from Settings). */
  model: string;
  models: ModelOption[];
  onModelChange: (id: string) => void;
  /** Reasoning effort, its setter, and whether the provider honours it (Claude). */
  effort: EffortLevel;
  onEffortChange: (e: EffortLevel) => void;
  supportsEffort: boolean;
  /** Display name of the active provider. */
  providerLabel: string;
  /** Which no-API-key login the provider uses, if any (drives the connect card). */
  subscription: "claude" | "chatgpt" | null;
  /** Provider runs on the user's machine (Ollama / LM Studio) → Private notes are unrestricted. */
  aiIsLocal: boolean;
  /** Provider can run vault skills (tool-using agent ops): Claude sub or Anthropic API. */
  agentCapable: boolean;
  /** Active provider preset — used to route the run tier to a concrete model. */
  preset: ProviderPreset;
  /** Vault-skill run tier (light/default/deep) + its setter (see routing.ts). */
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  onOpenSettings: () => void;
  /** When opened from search "Ask AI", auto-send this question against the vault. */
  seedQuery?: string;
  seedToken?: number;
  /** When a skill is invoked from the editor's "/" menu, run it (keyed on token). */
  skillReq?: { id: string; token: number } | null;
}

type Scope = "page" | "vault";

let turnId = 0;
const nextTurn = (): string => `turn-${turnId++}`;

function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

export function AIChatPanel({
  controller,
  chats,
  activePath,
  activeTitle,
  activeContent,
  files,
  onOpenNote,
  onClose,
  full,
  onToggleFull,
  model,
  models,
  onModelChange,
  effort,
  onEffortChange,
  supportsEffort,
  providerLabel,
  subscription,
  aiIsLocal,
  agentCapable,
  preset,
  runMode,
  onRunModeChange,
  onOpenSettings,
  seedQuery,
  seedToken,
  skillReq,
}: AIChatPanelProps) {
  const [input, setInput] = useState("");
  // Default to the whole vault ("All notes") and let it stick — opening a
  // different note no longer flips scope back to that page. Users who want to
  // focus on one note toggle to "This page" explicitly.
  const [scope, setScope] = useState<Scope>("vault");
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Highlighted row in the "/" skills menu (open when `input` is "/query").
  const [slashActive, setSlashActive] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { conn, status, checkStatus, recheck, stream, agentRun } = controller;

  // Built-in skills plus the user's own (stored in the vault as
  // .kestravault/skills.json, managed in Settings → AI guide). Re-read when
  // the vault's files change so edits made in Settings show up immediately.
  const [customSkills, setCustomSkills] = useState<VaultSkill[]>([]);
  useEffect(() => {
    let alive = true;
    void readCustomSkills().then((list) => {
      if (alive) setCustomSkills(list.map(toVaultSkill));
    });
    return () => {
      alive = false;
    };
  }, [files]);
  const allSkills = useMemo(() => [...VAULT_SKILLS, ...customSkills], [customSkills]);

  const activeChat = chats.activeChat;
  const turns = activeChat.turns;
  const activePrivacyMode: PrivacyMode = useMemo(() => {
    const fromTree = activePath ? files.find((f) => f.path === activePath)?.privacy?.mode : undefined;
    if (fromTree) return fromTree;
    return isPrivateNote(activeContent) ? "cloud-ai-private" : "public";
  }, [activePath, activeContent, files]);
  const activeAiAccess = remoteAiAccessForPrivacy(activePrivacyMode, { aiIsLocal });

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(scrollToBottom, [turns, activeChat.id, scrollToBottom]);

  const send = useCallback(
    async (text: string, opts?: { forcePage?: boolean; chatId?: string }) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      setInput("");

      const chatId = opts?.chatId ?? chats.activeId;
      const useScope: Scope = opts?.forcePage ? "page" : scope;
      const userTurn: ChatTurn = { id: nextTurn(), role: "user", content: prompt };
      const aTurn: ChatTurn = { id: nextTurn(), role: "assistant", content: "", streaming: true };
      // Snapshot the prior conversation for the model (text only).
      const prior = chats.getChat(chatId)?.turns ?? [];
      const history = [...prior, userTurn].map((t) => ({ role: t.role, content: t.content }));
      chats.updateTurns(chatId, (prev) => [...prev, userTurn, aTurn]);
      setBusy(true);

      // Log the question, and give the model time + recent-activity awareness.
      // The deeper 30-day digest is fetched only when the question looks temporal.
      recordActivity({ type: "ask", path: activePath ?? "", title: activeTitle || undefined, note: prompt });

      // Assemble context for this send.
      let system = ASSISTANT_PERSONA;
      // The vault's personalized brain instructions (written by onboarding, or
      // by hand) shape every answer — read fresh so external edits apply at once.
      try {
        system += brainContext(await window.api.vault.read(INSTRUCTIONS_PATH));
      } catch {
        /* no brain instructions yet — the base persona is fine */
      }
      try {
        const actx = await window.api.activity.context({ deep: isTemporalQuery(prompt) });
        system += timeContext(actx);
      } catch {
        /* activity context is best-effort — fall back to the base persona */
      }
      let sources: ChatSource[] | undefined;
      if (useScope === "page" && activePath) {
        // A Private note's body never goes to a remote provider — refuse the
        // page action with a clear message rather than silently dropping it.
        if (activeAiAccess !== "full") {
          chats.updateTurns(chatId, (prev) =>
            prev.map((t) =>
              t.id === aTurn.id
                ? {
                    ...t,
                    content:
                      activePrivacyMode === "local-only"
                        ? LOCAL_ONLY_PAGE_REFUSAL
                        : PRIVATE_PAGE_REFUSAL,
                    streaming: false,
                  }
                : t,
            ),
          );
          setBusy(false);
          cancelRef.current = null;
          return;
        }
        system += pageContext(activeTitle, activeContent, { aiIsLocal, privacyMode: activePrivacyMode });
      } else {
        // "All notes" scope: always give the model the full body of the note
        // the user currently has open — it's the most likely subject of a
        // question like "what should I do today?" — then add the top ranked
        // matches from the rest of the vault. pageContext guards Private notes.
        const parts: string[] = [];
        const srcs: ChatSource[] = [];
        if (activePath && activeAiAccess !== "none") {
          parts.push(pageContext(activeTitle, activeContent, { aiIsLocal, privacyMode: activePrivacyMode }));
          srcs.push({ name: activeTitle || noteName(activePath), path: activePath });
        }
        const matches = (await rankNotes(files, prompt, 6, aiIsLocal)).filter(
          (m) => m.path !== activePath,
        );
        if (matches.length) {
          parts.push(notesContext(matches));
          srcs.push(...matches.map((m) => ({ name: m.name, path: m.path })));
        }
        if (parts.length) system += parts.join("");
        if (srcs.length) sources = srcs;
      }

      const handle = stream(
        system,
        history,
        model,
        {
          onDelta: (delta) =>
            chats.updateTurns(chatId, (prev) =>
              prev.map((t) => (t.id === aTurn.id ? { ...t, content: t.content + delta } : t)),
            ),
          onDone: (fullText) => {
            setBusy(false);
            cancelRef.current = null;
            chats.updateTurns(chatId, (prev) =>
              prev.map((t) =>
                t.id === aTurn.id
                  ? { ...t, content: fullText || t.content, streaming: false, sources }
                  : t,
              ),
            );
          },
          onError: (_kind, message) => {
            setBusy(false);
            cancelRef.current = null;
            chats.updateTurns(chatId, (prev) =>
              prev.map((t) =>
                t.id === aTurn.id ? { ...t, content: message, streaming: false, error: true } : t,
              ),
            );
          },
        },
        supportsEffort ? effort : undefined,
      );
      cancelRef.current = handle.cancel;
    },
    [
      busy,
      scope,
      activePath,
      activeTitle,
      activeContent,
      files,
      model,
      effort,
      supportsEffort,
      aiIsLocal,
      activePrivacyMode,
      activeAiAccess,
      stream,
      chats,
    ],
  );

  // Run a vault skill: a tool-using agent run in the main process, streamed
  // into the chat like a normal turn plus a live "working" line and, at the
  // end, chips for every file it created, updated, or moved.
  const runSkill = useCallback(
    (skill: VaultSkill) => {
      if (busy) return;
      const chatId = chats.activeId;
      const say = (content: string): void =>
        chats.updateTurns(chatId, (prev) => [
          ...prev,
          { id: nextTurn(), role: "user", content: skill.turnLabel },
          { id: nextTurn(), role: "assistant", content },
        ]);
      if (!agentCapable) {
        say(SKILLS_NEED_CLAUDE);
        return;
      }
      if (skill.needsNote && !activePath) {
        say("Open the note you want to ingest first, then run this skill again.");
        return;
      }
      // Agent ops always run against Claude (a cloud provider), so a Private
      // note may not be ingested — its body must never leave the device.
      if (skill.needsNote && activePath && activePrivacyMode !== "public") {
        say(activePrivacyMode === "local-only" ? LOCAL_ONLY_PAGE_REFUSAL : PRIVATE_PAGE_REFUSAL);
        return;
      }

      const userTurn: ChatTurn = { id: nextTurn(), role: "user", content: skill.turnLabel };
      const aTurn: ChatTurn = {
        id: nextTurn(),
        role: "assistant",
        content: "",
        streaming: true,
        working: "Reading the vault guide…",
      };
      chats.updateTurns(chatId, (prev) => [...prev, userTurn, aTurn]);
      setBusy(true);
      recordActivity({
        type: "ask",
        path: activePath ?? "",
        title: activeTitle || undefined,
        note: skill.turnLabel,
      });

      const patch = (p: Partial<ChatTurn>): void =>
        chats.updateTurns(chatId, (prev) =>
          prev.map((t) => (t.id === aTurn.id ? { ...t, ...p } : t)),
        );
      // Route the run to a model tier (Haiku/Sonnet/Opus) per the chosen run
      // mode; non-Claude providers have no ladder and keep the chat model.
      const runModel = agentModelFor(preset, model, runMode);
      const handle = agentRun(
        skill.op,
        {
          targetPath: skill.needsNote ? (activePath ?? undefined) : undefined,
          model: runModel,
          prompt: skill.prompt,
        },
        {
          onDelta: (delta) =>
            chats.updateTurns(chatId, (prev) =>
              prev.map((t) => (t.id === aTurn.id ? { ...t, content: t.content + delta } : t)),
            ),
          onTool: (action, path) =>
            patch({
              working:
                action === "write"
                  ? `Editing ${path}…`
                  : action === "move"
                    ? `Moving ${path}…`
                    : action === "read"
                      ? `Reading ${path ?? "the vault"}…`
                      : "Searching the vault…",
            }),
          onDone: (fullText, changed) => {
            setBusy(false);
            cancelRef.current = null;
            chats.updateTurns(chatId, (prev) =>
              prev.map((t) =>
                t.id === aTurn.id
                  ? {
                      ...t,
                      content: fullText || t.content || "Done. Nothing needed changing.",
                      streaming: false,
                      working: undefined,
                      changed: changed.length ? changed : undefined,
                    }
                  : t,
              ),
            );
          },
          onError: (_kind, message) => {
            setBusy(false);
            cancelRef.current = null;
            patch({ content: message, streaming: false, working: undefined, error: true });
          },
        },
      );
      cancelRef.current = handle.cancel;
    },
    [
      busy,
      activePath,
      activeTitle,
      activeContent,
      model,
      preset,
      runMode,
      agentCapable,
      agentRun,
      chats,
      activePrivacyMode,
    ],
  );

  // Auto-send a seeded question (from the search bar's "Ask AI"). Each seed
  // lands in its own fresh chat. Keyed on the token so re-asks still fire.
  const sendRef = useRef(send);
  sendRef.current = send;
  const lastSeed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (seedQuery && seedToken !== lastSeed.current) {
      lastSeed.current = seedToken;
      const id = chats.startNewChat();
      setScope("vault");
      void sendRef.current(seedQuery, { chatId: id });
    }
  }, [seedToken, seedQuery, chats]);

  const stop = useCallback(() => cancelRef.current?.(), []);
  const newChat = useCallback(() => {
    stop();
    chats.startNewChat();
    setInput("");
    setHistoryOpen(false);
    inputRef.current?.focus();
  }, [stop, chats]);

  // "/" skills menu in the composer: open while the whole input is "/query"
  // (no spaces yet). Selecting a row runs the skill and clears the input.
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(input);
    return m ? (m[1] ?? "").toLowerCase() : null;
  }, [input]);
  const slashSkills = useMemo(() => {
    if (slashQuery === null) return [] as VaultSkill[];
    if (slashQuery === "") return allSkills;
    return allSkills.filter(
      (s) => s.id.includes(slashQuery) || s.label.toLowerCase().includes(slashQuery),
    );
  }, [slashQuery, allSkills]);
  const slashOpen = slashQuery !== null && slashSkills.length > 0;
  useEffect(() => setSlashActive(0), [slashQuery]);

  const pickSlash = useCallback(
    (i: number) => {
      const skill = slashSkills[i];
      if (!skill) return;
      setInput("");
      runSkill(skill);
    },
    [slashSkills, runSkill],
  );

  // A skill invoked from the editor's "/" menu (via App): run it once per token.
  const runSkillRef = useRef(runSkill);
  runSkillRef.current = runSkill;
  const lastSkill = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (skillReq && skillReq.token !== lastSkill.current) {
      lastSkill.current = skillReq.token;
      const skill = allSkills.find((s) => s.id === skillReq.id);
      if (skill) runSkillRef.current(skill);
    }
  }, [skillReq, allSkills]);

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen) {
      const n = slashSkills.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((i) => (i + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => (i - 1 + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashActive);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const empty = turns.length === 0;
  const disconnected = conn === "disconnected";

  const placeholder = useMemo(
    () => (scope === "page" && activePath ? "Ask about this page…" : "Ask, search, or make anything…"),
    [scope, activePath],
  );

  return (
    <aside className={`pane ai-panel${full ? " is-full" : ""}`}>
      <header className="ai-head">
        <div className="ai-head-left">
          <button
            className={`ai-chat-menu${historyOpen ? " is-open" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title="Chat history"
          >
            <AiAvatar size={18} />
            <span className="ai-chat-name">{activeChat.title || "New chat"}</span>
            <AiIcon name="chevron" size={14} />
          </button>
          {historyOpen ? (
            <ChatHistoryMenu
              chats={chats}
              onSelect={(id) => {
                chats.select(id);
                setHistoryOpen(false);
              }}
              onNew={newChat}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
        </div>
        <div className="ai-head-actions">
          <button className="icon-btn" title="New chat" onClick={newChat}>
            <NewNoteIcon size={17} />
          </button>
          <button
            className="icon-btn"
            title={full ? "Exit full view" : "Full view"}
            onClick={onToggleFull}
          >
            <AiIcon name={full ? "collapse" : "expand"} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <AiIcon name="close" />
          </button>
        </div>
      </header>

      <div className="ai-scroll" ref={scrollRef}>
        {disconnected ? (
          <ConnectCard
            status={status}
            subscription={subscription}
            providerLabel={providerLabel}
            onRecheck={() => void recheck()}
            onOpenSettings={onOpenSettings}
          />
        ) : empty ? (
          <EmptyState
            checking={conn === "checking" || conn === "unknown"}
            providerLabel={providerLabel}
            hasNote={!!activePath}
            skills={allSkills}
            onAction={(prompt) => void send(prompt, { forcePage: true })}
            onSuggest={(q) => {
              setScope("vault");
              void send(q);
            }}
            onSkill={runSkill}
          />
        ) : (
          <div className="ai-thread">
            {turns.map((t) =>
              t.role === "user" ? (
                <div key={t.id} className="ai-msg ai-msg-user">
                  <div className="ai-bubble">{t.content}</div>
                </div>
              ) : (
                <div key={t.id} className="ai-msg ai-msg-assistant">
                  <AiAvatar size={22} className="ai-msg-avatar" />
                  <div className="ai-msg-body">
                    {t.error ? (
                      <div className="ai-error">{t.content}</div>
                    ) : t.content ? (
                      <Markdown text={t.content} files={files} onOpenNote={onOpenNote} />
                    ) : (
                      <ThinkingDots />
                    )}
                    {t.streaming && t.content ? <span className="ai-caret" /> : null}
                    {t.streaming && t.working ? (
                      <div className="ai-working">{t.working}</div>
                    ) : null}
                    {t.changed && t.changed.length ? (
                      <div className="ai-sources">
                        <span className="ai-sources-label">Changed files</span>
                        {t.changed.map((c) => (
                          <button
                            key={`${c.op}-${c.path}`}
                            className="ai-source-chip"
                            onClick={() => onOpenNote(c.path)}
                            title={
                              c.op === "create"
                                ? `Created ${c.path}`
                                : c.op === "move"
                                  ? `Moved ${c.from ?? "?"} → ${c.path}`
                                  : `Updated ${c.path}`
                            }
                          >
                            <AiIcon name="doc" /> {c.op === "create" ? "+ " : c.op === "move" ? "→ " : ""}
                            {c.path}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {t.sources && t.sources.length ? (
                      <div className="ai-sources">
                        <span className="ai-sources-label">Sources</span>
                        {t.sources.slice(0, 4).map((s) => (
                          <button
                            key={s.path}
                            className="ai-source-chip"
                            onClick={() => onOpenNote(s.path)}
                            title={s.path}
                          >
                            <AiIcon name="doc" /> {s.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {!disconnected ? (
        <div className="ai-composer">
          <div className="ai-composer-box">
            {slashOpen ? (
              <div className="ai-slash-menu">
                <div
                  className="ai-slash-head"
                  title={
                    agentCapable
                      ? "Vault skills — agent operations on your notes. Add your own in Settings → AI guide."
                      : "Vault skills need Claude (subscription or Anthropic API)"
                  }
                >
                  Skills
                </div>
                {slashSkills.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`ai-skill-row${i === slashActive ? " is-active" : ""}`}
                    title={s.description}
                    onMouseEnter={() => setSlashActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSlash(i)}
                  >
                    <span className="ai-action-icon">
                      <AiIcon name={s.icon} />
                    </span>
                    <span className="ai-skill-text">
                      <span className="ai-skill-label">{s.label}</span>
                      <span className="ai-skill-desc">{s.description}</span>
                    </span>
                  </button>
                ))}
                {agentCapable && isRoutable(preset) ? (
                  <div className="ai-runmode" title="Model tier for this run (routing.ts)">
                    <span className="ai-runmode-label">Run tier</span>
                    <div className="ai-runmode-seg">
                      {RUN_MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`ai-runmode-opt${runMode === m.id ? " is-active" : ""}`}
                          title={m.blurb}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => onRunModeChange(m.id)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              className="ai-input"
              placeholder={placeholder}
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKey}
            />
            <div className="ai-composer-foot">
              <div className="ai-composer-left">
                {activePath ? (
                  <button
                    className={`ai-scope${scope === "page" ? " is-on" : ""}`}
                    onClick={() => setScope((s) => (s === "page" ? "vault" : "page"))}
                    title="Switch between this page and your whole vault"
                  >
                    <AiIcon name={scope === "page" ? "doc" : "vault"} />
                    {scope === "page" ? "This page" : "All notes"}
                  </button>
                ) : (
                  <span className="ai-scope is-static">
                    <AiIcon name="vault" /> All notes
                  </span>
                )}
                {models.length > 0 ? (
                  <ComposerPicker
                    className="ai-model"
                    value={model}
                    options={
                      models.some((m) => m.id === model)
                        ? models
                        : [{ id: model, label: model || "default" }, ...models]
                    }
                    onChange={onModelChange}
                    title={`Model · ${providerLabel}`}
                  />
                ) : (
                  <button
                    className="ai-picker-trigger ai-model"
                    onClick={onOpenSettings}
                    title="Set the model in Settings"
                  >
                    <span>{model || "Set model"}</span>
                  </button>
                )}
                {supportsEffort ? <EffortPicker value={effort} onChange={onEffortChange} /> : null}
              </div>
              {busy ? (
                <button className="ai-send is-stop" onClick={stop} title="Stop">
                  <AiIcon name="stop" />
                </button>
              ) : (
                <button
                  className="ai-send"
                  onClick={() => void send(input)}
                  disabled={!input.trim()}
                  title="Send"
                >
                  <AiIcon name="send" />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function EffortPicker({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (value: EffortLevel) => void;
}) {
  return (
    <ComposerPicker
      className="ai-effort"
      value={value}
      options={EFFORT_OPTIONS.map((option) => ({
        id: option.id,
        label: `${option.label} effort`,
      }))}
      onChange={onChange}
      title="Reasoning effort — how hard the model thinks before replying"
    />
  );
}

function ComposerPicker<T extends string>({
  className,
  value,
  options,
  onChange,
  title,
}: {
  className: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedLabel = useMemo(() => {
    const option = options.find((o) => o.id === value);
    return option?.label ?? value;
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`ai-picker ${className}`} ref={ref}>
      <button
        type="button"
        className={`ai-picker-trigger${open ? " is-open" : ""}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selectedLabel}</span>
        <AiIcon name="chevron" size={13} />
      </button>
      {open ? (
        <div className="ai-picker-menu" role="menu">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === value}
              className={`ai-picker-option${option.id === value ? " is-active" : ""}`}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChatHistoryMenu({
  chats,
  onSelect,
  onNew,
  onClose,
}: {
  chats: ChatsController;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      const target = e.target as Element;
      // Ignore clicks on the trigger — its own onClick toggles the menu, so
      // closing here too would immediately reopen it.
      if (ref.current && !ref.current.contains(target) && !target.closest(".ai-chat-menu")) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const list = useMemo(
    () => chats.chats.filter((c) => c.turns.length > 0).sort((a, b) => b.updatedAt - a.updatedAt),
    [chats.chats],
  );

  return (
    <div className="ai-history" ref={ref}>
      <button className="ai-history-new" onClick={onNew}>
        <NewNoteIcon size={15} />
        New chat
      </button>
      {list.length ? (
        <ul className="ai-history-list">
          {list.map((c) => (
            <li
              key={c.id}
              className={`ai-history-row${c.id === chats.activeId ? " is-active" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="ai-history-name">{c.title || "Untitled chat"}</span>
              <span className="ai-history-time">{relTime(c.updatedAt)}</span>
              <button
                className="ai-history-del"
                title="Delete chat"
                onClick={(e) => {
                  e.stopPropagation();
                  chats.deleteChat(c.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ai-history-empty">No previous chats yet</div>
      )}
    </div>
  );
}

function EmptyState({
  checking,
  providerLabel,
  hasNote,
  skills: allSkills,
  onAction,
  onSuggest,
  onSkill,
}: {
  checking: boolean;
  providerLabel: string;
  hasNote: boolean;
  skills: VaultSkill[];
  onAction: (prompt: string) => void;
  onSuggest: (q: string) => void;
  onSkill: (skill: VaultSkill) => void;
}) {
  const skills = allSkills.filter((s) => !s.needsNote || hasNote).slice(0, 4);
  return (
    <div className="ai-empty">
      <AiAvatar size={40} />
      <div className="ai-empty-title">How can I help you today?</div>
      {checking ? <div className="ai-empty-sub">Connecting to {providerLabel}…</div> : null}
      <div className="ai-actions">
        {skills.map((s) => (
          <button key={s.id} className="ai-action" title={s.description} onClick={() => onSkill(s)}>
            <span className="ai-action-icon">
              <AiIcon name={s.icon} />
            </span>
            {s.label}
          </button>
        ))}
        {hasNote
          ? PAGE_ACTIONS.map((a) => (
              <button key={a.id} className="ai-action" onClick={() => onAction(a.prompt)}>
                <span className="ai-action-icon">
                  <AiIcon name={a.icon} />
                </span>
                {a.label}
              </button>
            ))
          : ASK_SUGGESTIONS.map((q) => (
              <button key={q} className="ai-action" onClick={() => onSuggest(q)}>
                <span className="ai-action-icon">
                  <AiIcon name="search" />
                </span>
                {q}
              </button>
            ))}
      </div>
    </div>
  );
}

function ConnectCard({
  status,
  subscription,
  providerLabel,
  onRecheck,
  onOpenSettings,
}: {
  status: { detail?: string } | null;
  subscription: "claude" | "chatgpt" | null;
  providerLabel: string;
  onRecheck: () => void;
  onOpenSettings: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = subscription === "chatgpt" ? "codex" : "claude";
  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Non-subscription providers (API key / local model) are configured in
  // Settings, so point there instead of the terminal login flow.
  if (!subscription) {
    return (
      <div className="ai-connect">
        <AiAvatar size={40} />
        <div className="ai-connect-title">Set up {providerLabel}</div>
        <p className="ai-connect-text">
          KestraVault is <strong>bring-your-own-model</strong>. Add your API key (or start your local
          model) in Settings, then re-check the connection.
        </p>
        <div className="ai-connect-actions">
          <button className="ai-btn-primary" onClick={onOpenSettings}>
            Open AI settings
          </button>
          <button className="ai-btn-ghost" onClick={onRecheck}>
            Re-check
          </button>
        </div>
        {status?.detail ? <div className="ai-connect-detail">{status.detail}</div> : null}
      </div>
    );
  }

  return (
    <div className="ai-connect">
      <AiAvatar size={40} />
      <div className="ai-connect-title">
        {subscription === "chatgpt" ? "Connect your ChatGPT account" : "Connect your Claude account"}
      </div>
      <p className="ai-connect-text">
        {subscription === "chatgpt" ? (
          <>
            KestraVault runs on your <strong>ChatGPT Plus/Pro subscription</strong> — no API key
            needed. It reuses the same login as the Codex CLI.
          </>
        ) : (
          <>
            KestraVault runs on your <strong>Claude Pro/Max subscription</strong> — no API key
            needed. It reuses the same login as Claude Code.
          </>
        )}
      </p>
      {subscription === "chatgpt" ? (
        <ol className="ai-connect-steps">
          <li>
            Install the Codex CLI: <code>npm install -g @openai/codex</code>
          </li>
          <li>
            Run <code>codex</code> and choose <em>“Sign in with ChatGPT”</em>
          </li>
          <li>Come back here and re-check the connection</li>
        </ol>
      ) : (
        <ol className="ai-connect-steps">
          <li>
            Open a Terminal and run <code>claude</code>
          </li>
          <li>
            Type <code>/login</code> and choose <em>“Claude account with subscription”</em>
          </li>
          <li>Come back here and re-check the connection</li>
        </ol>
      )}
      <div className="ai-connect-actions">
        <button className="ai-btn-primary" onClick={onRecheck}>
          Re-check connection
        </button>
        <button className="ai-btn-ghost" onClick={copy}>
          {copied ? "Copied!" : `Copy “${command}”`}
        </button>
      </div>
      <button className="ai-connect-link" onClick={onOpenSettings}>
        Use a different model →
      </button>
      {status?.detail ? <div className="ai-connect-detail">{status.detail}</div> : null}
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="ai-thinking" aria-label="Thinking">
      <span />
      <span />
      <span />
    </span>
  );
}
