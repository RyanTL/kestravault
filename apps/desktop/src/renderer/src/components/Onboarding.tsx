import { useEffect, useMemo, useRef, useState } from "react";
import { AiAvatar } from "@renderer/components/AiIcons";
import type { AiController } from "@renderer/vault/useAi";
import {
  FOLDER_CHOICES,
  LANGUAGE_CHOICES,
  PURPOSES,
  applyBrainSetup,
  buildInstructions,
  defaultProfile,
  enhancePrompt,
  enhanceSystem,
  looksLikeInstructions,
  purposeOf,
  readBrainConfig,
  skipBrainSetup,
  type ApplyBrainResult,
  type BrainProfile,
} from "@renderer/vault/brain";
import "./Onboarding.css";

// The new-vault onboarding wizard. A few questions → the app scaffolds the
// user's own structure: the folders they picked plus .kestravault/instructions.md
// (the AI guide: purpose, working rules, and the vault map the AI keeps
// current). When an AI provider is connected the guide is rewritten by the
// model itself ("personalize"); otherwise the template ships as-is and can be
// personalized later by re-running the wizard.

export interface OnboardingProps {
  vaultName: string;
  ai: AiController;
  model: string;
  providerLabel: string;
  /** Prefill when re-running on a vault that already has a profile. */
  initialProfile?: BrainProfile;
  onOpenSettings: () => void;
  /** "done" → brain written; "skipped" → don't ask again; "cancelled" → no change. */
  onClose: (result: "done" | "skipped" | "cancelled", applied?: ApplyBrainResult) => void;
}

type Phase = "form" | "enhancing" | "applying" | "done";

const STEPS = ["Welcome", "Purpose", "About", "Preferences", "Create"] as const;

export function Onboarding({
  vaultName,
  ai,
  model,
  providerLabel,
  initialProfile,
  onOpenSettings,
  onClose,
}: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<BrainProfile>(initialProfile ?? defaultProfile());
  const [phase, setPhase] = useState<Phase>("form");
  const [preview, setPreview] = useState("");
  const [applied, setApplied] = useState<ApplyBrainResult | null>(null);
  const [error, setError] = useState("");
  const cancelEnhance = useRef<(() => void) | null>(null);

  const patch = (p: Partial<BrainProfile>): void => setProfile((cur) => ({ ...cur, ...p }));

  // Know whether an AI provider is reachable before the Create step, so the
  // wizard can offer "personalize with AI" vs the template path.
  const { checkStatus } = ai;
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const connected = ai.conn === "connected";
  const template = useMemo(() => buildInstructions(profile, vaultName), [profile, vaultName]);

  function pickPurpose(id: BrainProfile["purpose"]): void {
    // Choosing a purpose resets the folder selection to its defaults; the
    // Preferences step still lets the user tweak them.
    setProfile((cur) => ({ ...cur, purpose: id, folders: purposeOf(id).folders }));
    setStep(2);
  }

  function toggleFolder(folder: string): void {
    setProfile((cur) => ({
      ...cur,
      folders: cur.folders.includes(folder)
        ? cur.folders.filter((f) => f !== folder)
        : [...cur.folders, folder],
    }));
  }

  async function apply(aiInstructions?: string): Promise<void> {
    setPhase("applying");
    try {
      const result = await applyBrainSetup(profile, vaultName, { aiInstructions });
      setApplied(result);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("form");
    }
  }

  // Create with an AI pass: stream the personalized instructions into the
  // preview, then write everything. Any failure falls back to the template so
  // onboarding never dead-ends.
  function createWithAi(): void {
    setError("");
    setPhase("enhancing");
    setPreview("");
    const handle = ai.stream(
      enhanceSystem(),
      [{ role: "user", content: enhancePrompt(profile, template) }],
      model,
      {
        onDelta: (t) => setPreview((p) => p + t),
        onDone: (full) => {
          cancelEnhance.current = null;
          void apply(looksLikeInstructions(full) ? full : undefined);
        },
        onError: () => {
          cancelEnhance.current = null;
          void apply(undefined); // template fallback — never block on the AI
        },
      },
    );
    cancelEnhance.current = handle.cancel;
  }

  function skip(): void {
    cancelEnhance.current?.();
    // First run on this vault: remember the skip so the wizard doesn't nag on
    // every launch (it stays reachable via the "Set up my brain" command). A
    // re-run over an existing config just closes — never downgrade "done".
    void (async () => {
      const existing = await readBrainConfig();
      if (!existing) {
        await skipBrainSetup();
        onClose("skipped");
      } else {
        onClose("cancelled");
      }
    })();
  }

  const busy = phase === "enhancing" || phase === "applying";

  return (
    <div className="overlay onboarding-overlay">
      <div className="onboarding" role="dialog" aria-label="Set up your vault">
        <header className="onboarding-head">
          <AiAvatar size={22} />
          <span className="onboarding-vault">{vaultName}</span>
          <div className="onboarding-steps">
            {STEPS.map((s, i) => (
              <span key={s} className={`onboarding-dot${i === step ? " is-on" : ""}`} title={s} />
            ))}
          </div>
          {!busy && phase !== "done" ? (
            <button className="onboarding-skip" onClick={skip}>
              Skip for now
            </button>
          ) : null}
        </header>

        {phase === "done" && applied ? (
          <div className="onboarding-body">
            <h2>Your vault is ready 🎉</h2>
            <p>
              The AI now follows a guide written just for this vault — your folders, your rules,
              and a vault map it keeps current so it can always find what you need. Write notes,
              use <strong>File this note</strong> in the AI chat to put things where they belong,
              and run <strong>Tidy my vault</strong> now and then to keep everything healthy.
            </p>
            <ul className="onboarding-files">
              <li>
                Your AI guide is saved inside the vault. You can edit it anytime in Settings →
                AI guide — or let the AI reorganize and re-index everything for you from there.
              </li>
              <li>Everything you already had was left untouched.</li>
            </ul>
            <footer className="onboarding-foot">
              <button className="ai-btn-primary" onClick={() => onClose("done", applied)}>
                Start writing
              </button>
            </footer>
          </div>
        ) : phase === "enhancing" || phase === "applying" ? (
          <div className="onboarding-body">
            <h2>{phase === "enhancing" ? "Personalizing your vault…" : "Setting up your vault…"}</h2>
            <p className="onboarding-hint">
              {phase === "enhancing"
                ? `${providerLabel} is writing this vault's AI guide from your answers.`
                : "Creating your folders and the AI guide."}
            </p>
            {preview ? <pre className="onboarding-preview">{preview}</pre> : null}
          </div>
        ) : step === 0 ? (
          <div className="onboarding-body">
            <h2>Set up your second brain</h2>
            <p>
              This vault can be more than notes: an AI helps you organize, connect, and find
              everything — using a structure that's <strong>yours</strong>, not one imposed on
              you.
            </p>
            <p>
              A few questions will shape how the AI works <em>here</em>: what the vault is for,
              which folders it starts with, how the AI should write, and how much it should check
              with you. Your answers become this vault's AI guide — a short file the AI reads
              before every operation, with a map of your structure it keeps current. You can edit
              it anytime.
            </p>
            <footer className="onboarding-foot">
              <button className="ai-btn-primary" onClick={() => setStep(1)}>
                Let's set it up
              </button>
            </footer>
          </div>
        ) : step === 1 ? (
          <div className="onboarding-body">
            <h2>What is this brain for?</h2>
            <div className="onboarding-cards">
              {PURPOSES.map((p) => (
                <button
                  key={p.id}
                  className={`onboarding-card${profile.purpose === p.id ? " is-on" : ""}`}
                  onClick={() => pickPurpose(p.id)}
                >
                  <span className="onboarding-card-title">{p.label}</span>
                  <span className="onboarding-card-desc">{p.description}</span>
                </button>
              ))}
            </div>
            <footer className="onboarding-foot">
              <button className="ai-btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
            </footer>
          </div>
        ) : step === 2 ? (
          <div className="onboarding-body">
            <h2>Tell it what to expect</h2>
            <label className="onboarding-label">
              What topics or domains will you feed it? <span>(optional but powerful)</span>
              <textarea
                rows={2}
                value={profile.topics}
                placeholder="e.g. AI research papers, my startup's market, Roman history…"
                onChange={(e) => patch({ topics: e.target.value })}
              />
            </label>
            <label className="onboarding-label">
              About you: role, background, what you care about <span>(optional)</span>
              <textarea
                rows={2}
                value={profile.about}
                placeholder="e.g. Product engineer, technical but new to biology; I skim first, deep-dive later."
                onChange={(e) => patch({ about: e.target.value })}
              />
            </label>
            <footer className="onboarding-foot">
              <button className="ai-btn-ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="ai-btn-primary" onClick={() => setStep(3)}>
                Continue
              </button>
            </footer>
          </div>
        ) : step === 3 ? (
          <div className="onboarding-body">
            <h2>How should it work?</h2>
            <div className="onboarding-row">
              <span className="onboarding-row-label">Writing style</span>
              <div className="onboarding-seg">
                <button
                  className={profile.style === "concise" ? "is-on" : ""}
                  onClick={() => patch({ style: "concise" })}
                >
                  Concise bullets
                </button>
                <button
                  className={profile.style === "detailed" ? "is-on" : ""}
                  onClick={() => patch({ style: "detailed" })}
                >
                  Detailed prose
                </button>
              </div>
            </div>
            <div className="onboarding-row">
              <span className="onboarding-row-label">Language</span>
              <select
                value={profile.language}
                onChange={(e) => patch({ language: e.target.value })}
              >
                {LANGUAGE_CHOICES.map((l) => (
                  <option key={l || "auto"} value={l}>
                    {l || "Match my notes"}
                  </option>
                ))}
              </select>
            </div>
            <div className="onboarding-row">
              <span className="onboarding-row-label">When organizing</span>
              <div className="onboarding-seg">
                <button
                  className={profile.ingestMode === "guided" ? "is-on" : ""}
                  title="The AI tells you what it plans to change before touching anything"
                  onClick={() => patch({ ingestMode: "guided" })}
                >
                  Discuss with me first
                </button>
                <button
                  className={profile.ingestMode === "auto" ? "is-on" : ""}
                  title="The AI organizes directly and summarizes what changed"
                  onClick={() => patch({ ingestMode: "auto" })}
                >
                  Organize automatically
                </button>
              </div>
            </div>
            <div className="onboarding-row">
              <span className="onboarding-row-label">Starting folders</span>
              <div className="onboarding-tags">
                {FOLDER_CHOICES.map((f) => (
                  <button
                    key={f}
                    className={`onboarding-tag${profile.folders.includes(f) ? " is-on" : ""}`}
                    onClick={() => toggleFolder(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <footer className="onboarding-foot">
              <button className="ai-btn-ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                className="ai-btn-primary"
                disabled={profile.folders.length === 0}
                onClick={() => setStep(4)}
              >
                Continue
              </button>
            </footer>
          </div>
        ) : (
          <div className="onboarding-body">
            <h2>Create your setup</h2>
            <p>
              Here's what you'll get. Anything already in your vault stays untouched; only the AI
              guide is refreshed.
            </p>
            <ul className="onboarding-files">
              <li>
                <strong>Your folders</strong> ({profile.folders.join(", ")}) — a starting
                structure the AI grows with you.
              </li>
              <li>
                <strong>A personal AI guide</strong> built from your answers. The AI reads it
                before every operation, and you can edit it anytime in Settings.
              </li>
              <li>
                <strong>A vault map</strong> inside the guide — an index the AI keeps current so
                it can find anything without scanning every file.
              </li>
            </ul>
            {error ? <div className="ai-error">{error}</div> : null}
            {connected ? (
              <footer className="onboarding-foot">
                <button className="ai-btn-ghost" onClick={() => setStep(3)}>
                  Back
                </button>
                <button className="ai-btn-ghost" onClick={() => void apply(undefined)}>
                  Use template only
                </button>
                <button className="ai-btn-primary" onClick={createWithAi}>
                  Create & personalize with AI
                </button>
              </footer>
            ) : (
              <>
                <p className="onboarding-hint">
                  {providerLabel} isn't connected yet, so your AI guide will start from a solid
                  template built from your answers. Connect a model later and re-run{" "}
                  <em>Set up my vault</em> to have the AI personalize it further.
                </p>
                <footer className="onboarding-foot">
                  <button className="ai-btn-ghost" onClick={() => setStep(3)}>
                    Back
                  </button>
                  <button className="ai-btn-ghost" onClick={onOpenSettings}>
                    AI settings
                  </button>
                  <button className="ai-btn-ghost" onClick={() => void ai.recheck()}>
                    Re-check connection
                  </button>
                  <button className="ai-btn-primary" onClick={() => void apply(undefined)}>
                    Create my setup
                  </button>
                </footer>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
