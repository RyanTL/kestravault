import { useEffect, useMemo, useRef, useState } from "react";
import { AiAvatar } from "@renderer/components/AiIcons";
import type { AiController } from "@renderer/vault/useAi";
import {
  CATEGORY_CHOICES,
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
// vault's "brain": folder zones, .kestravault/instructions.md (the schema the AI
// follows everywhere), AGENTS.md/CLAUDE.md stubs for external tools, index.md
// and log.md. When an AI provider is connected the instructions are rewritten
// by the model itself ("personalize"); otherwise the template ships as-is and
// can be personalized later by re-running the wizard.

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
    // Choosing a purpose resets the category selection to its defaults; the
    // Preferences step still lets the user tweak them.
    setProfile((cur) => ({ ...cur, purpose: id, categories: purposeOf(id).categories }));
    setStep(2);
  }

  function toggleCategory(cat: string): void {
    setProfile((cur) => ({
      ...cur,
      categories: cur.categories.includes(cat)
        ? cur.categories.filter((c) => c !== cat)
        : [...cur.categories, cat],
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
      <div className="onboarding" role="dialog" aria-label="Set up your brain">
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
            <h2>Your brain is ready 🎉</h2>
            <p>
              The AI now follows a guide written just for this vault. Drop material into the{" "}
              <strong>sources</strong> folder, use <strong>Ingest</strong> in the AI chat to file
              it into your wiki, and run <strong>Lint</strong> now and then to keep everything
              healthy.
            </p>
            <ul className="onboarding-files">
              <li>
                Your instruction guide is saved inside the vault. You can edit it anytime, and it
                keeps improving as your preferences are added.
              </li>
              <li>
                Other AI tools (Claude Code, ChatGPT/Codex) will follow the same rules if you ever
                open this folder with them.
              </li>
              {applied.kept.length ? (
                <li>Everything you already had was left untouched.</li>
              ) : null}
            </ul>
            <footer className="onboarding-foot">
              <button className="ai-btn-primary" onClick={() => onClose("done", applied)}>
                Start using my brain
              </button>
            </footer>
          </div>
        ) : phase === "enhancing" || phase === "applying" ? (
          <div className="onboarding-body">
            <h2>{phase === "enhancing" ? "Personalizing your brain…" : "Creating your brain…"}</h2>
            <p className="onboarding-hint">
              {phase === "enhancing"
                ? `${providerLabel} is writing this vault's instruction guide from your answers.`
                : "Setting up your vault."}
            </p>
            {preview ? <pre className="onboarding-preview">{preview}</pre> : null}
          </div>
        ) : step === 0 ? (
          <div className="onboarding-body">
            <h2>Set up your second brain</h2>
            <p>
              This vault can be more than notes: you drop in raw material and an AI builds and
              maintains an interlinked <strong>wiki</strong> from it, with summaries,
              cross-references, flagged contradictions, and an index that stays current.
            </p>
            <p>
              A few questions will shape how the AI works <em>here</em>: what it's for, how it
              should write, and how much it should check with you. Your answers become this vault's
              instruction guide, which you can edit anytime and which improves as you use it.
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
              <span className="onboarding-row-label">When ingesting</span>
              <div className="onboarding-seg">
                <button
                  className={profile.ingestMode === "guided" ? "is-on" : ""}
                  title="The AI shares takeaways and checks with you before filing"
                  onClick={() => patch({ ingestMode: "guided" })}
                >
                  Discuss with me first
                </button>
                <button
                  className={profile.ingestMode === "auto" ? "is-on" : ""}
                  title="The AI files sources directly and summarizes what changed"
                  onClick={() => patch({ ingestMode: "auto" })}
                >
                  File automatically
                </button>
              </div>
            </div>
            <div className="onboarding-row">
              <span className="onboarding-row-label">Wiki sections</span>
              <div className="onboarding-tags">
                {CATEGORY_CHOICES.map((c) => (
                  <button
                    key={c}
                    className={`onboarding-tag${profile.categories.includes(c) ? " is-on" : ""}`}
                    onClick={() => toggleCategory(c)}
                  >
                    {c}
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
                disabled={profile.categories.length === 0}
                onClick={() => setStep(4)}
              >
                Continue
              </button>
            </footer>
          </div>
        ) : (
          <div className="onboarding-body">
            <h2>Create your brain</h2>
            <p>
              Here's what you'll get. Anything already in your vault stays untouched; only the
              instruction guide is refreshed.
            </p>
            <ul className="onboarding-files">
              <li>
                <strong>Tidy folders</strong> for your raw material, your own notes, and the AI's
                wiki ({profile.categories.join(", ")})
              </li>
              <li>
                <strong>A personal instruction guide</strong> built from your answers. The AI
                follows it in everything it does here, and you can edit it anytime.
              </li>
              <li>
                <strong>An index and an activity log</strong> so you can always see what's in the
                wiki and what changed.
              </li>
              <li>
                <strong>Support for other AI tools</strong> like Claude Code and ChatGPT (Codex),
                which follow the same rules if you open this folder with them.
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
                  {providerLabel} isn't connected yet, so your instruction guide will start from a
                  solid template built from your answers. Connect a model later and re-run{" "}
                  <em>Set up my brain</em> to have the AI personalize it further.
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
                    Create my brain
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
