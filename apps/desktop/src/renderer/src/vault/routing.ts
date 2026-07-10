import type { RunMode } from "@kestravault/core";
import type { ProviderPreset } from "./useSettings";

// ── Model routing (plan/agent-loop.md "Model routing") ──────────────────────
// Tiered models, applied per run: grunt work goes to the cheap tier (Haiku),
// synthesis to the mid tier (Sonnet), and "deep" runs escalate to Opus. Tiering
// is per-operation — a single agent run keeps one model throughout.
//
// Only the Claude providers have a known tier ladder; for every other provider
// (OpenAI-compatible, local) we can't guess the catalogue, so everything falls
// back to the user's chosen chat model.

const CLAUDE_TIERS: Partial<Record<ProviderPreset["kind"], Record<RunMode, string>>> = {
  subscription: { light: "haiku", default: "sonnet", deep: "opus" },
  anthropic: {
    light: "claude-haiku-4-5",
    default: "claude-sonnet-5",
    deep: "claude-opus-4-8",
  },
};

export const RUN_MODES: { id: RunMode; label: string; blurb: string }[] = [
  { id: "light", label: "Light", blurb: "Haiku — fast + cheap, fine for routine sources" },
  { id: "default", label: "Balanced", blurb: "Sonnet — the default for wiki-quality writing" },
  { id: "deep", label: "Deep", blurb: "Opus — dense or high-stakes material" },
];

/** Whether the provider has a tier ladder to route across (Claude only). */
export function isRoutable(preset: ProviderPreset): boolean {
  return CLAUDE_TIERS[preset.kind] !== undefined;
}

/** The model an agent run (Ingest / Lint) should use for a given run mode. */
export function agentModelFor(preset: ProviderPreset, chatModel: string, mode: RunMode): string {
  return CLAUDE_TIERS[preset.kind]?.[mode] ?? chatModel;
}

/** The cheap tier for grunt work — titles, summaries, retrieval passes. */
export function gruntModelFor(preset: ProviderPreset, chatModel: string): string {
  return agentModelFor(preset, chatModel, "light");
}
