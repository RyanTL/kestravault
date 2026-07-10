import { parseFrontmatter } from "@kestravault/core";
import { remoteAiAccessForPrivacy, type PrivacyMode } from "@kestravault/core";
import { isPrivate, noteDescription } from "@renderer/vault/notePrivacy";
import type { NoteMatch } from "@renderer/vault/search";
import type { ActivityContextPayload, ActivityItem } from "@renderer/env";

// Prompt construction for the AI features. Kept declarative so the persona and
// the page actions read at a glance and stay easy to tweak.

export const ASSISTANT_PERSONA = [
  "You are KestraVault AI, the assistant inside a personal markdown notes app (an Obsidian-style vault).",
  "You help the user think, write, and find things across their own notes.",
  "Be concise and direct. Use clean Markdown (headings, bullet lists, **bold**) when it helps readability.",
  "When notes are provided as context, ground your answer in them and cite note titles in **bold** when relevant.",
  "If the notes don't contain the answer, say so briefly instead of inventing facts.",
].join(" ");

/** Shown in place of a Private note's body so the AI knows it exists but blind. */
export const PRIVATE_BODY_PLACEHOLDER = "(private — body hidden)";

/** Returned to the user when a page action targets a Private note on a remote provider. */
export const PRIVATE_PAGE_REFUSAL =
  "🔒 This note is marked **Private**, so its contents stay on your device and aren't sent to a cloud AI. " +
  "Switch to a local model (Ollama / LM Studio) in Settings to ask about this page.";

export const LOCAL_ONLY_PAGE_REFUSAL =
  "This note is marked **Local only**, so it is excluded from cloud sync and remote AI. " +
  "Switch to a local model (Ollama / LM Studio) in Settings to ask about this page.";

/** Wrap ranked note matches as a context block appended to the system prompt. */
export function notesContext(matches: NoteMatch[]): string {
  if (matches.length === 0) return "";
  const blocks = matches
    .map((m) => {
      // Private notes stay discoverable by title (and description) but their
      // body is never emitted here — guard against a stray snippet leaking too.
      const preview = m.private
        ? [PRIVATE_BODY_PLACEHOLDER, m.description].filter(Boolean).join("\n")
        : m.snippet || "(no preview)";
      return `### ${m.name}\n${preview}`;
    })
    .join("\n\n");
  return `\n\nThe user's notes that may be relevant:\n\n${blocks}`;
}

/** Context for "this page" actions: the active note's title + body. */
export function pageContext(
  title: string,
  content: string,
  opts: { aiIsLocal?: boolean; privacyMode?: PrivacyMode } = {},
): string {
  const { data, body } = parseFrontmatter(content);
  const mode = opts.privacyMode ?? (isPrivate(data) ? "cloud-ai-private" : "public");
  const access = remoteAiAccessForPrivacy(mode, { aiIsLocal: opts.aiIsLocal });
  // A Private note's body must never reach a remote provider — describe it by
  // title/description instead. Local providers get the full note (nothing leaves
  // the device), so the restriction is relaxed there.
  if (access === "none") {
    return (
      `\n\nThe current note is titled "${title}". It is marked **local-only**, so its body is ` +
      `not available to you — do not guess at its contents.`
    );
  }
  if (access === "metadata") {
    const desc = noteDescription(data);
    return (
      `\n\nThe current note is titled "${title}". It is marked **private**, so its body is ` +
      `hidden from you ${PRIVATE_BODY_PLACEHOLDER} — do not guess at its contents.` +
      (desc ? `\nDescription: ${desc}` : "")
    );
  }
  return `\n\nThe current note is titled "${title}". Its full contents:\n\n"""\n${body.trim()}\n"""`;
}

// ---- Time & activity awareness --------------------------------------------
// The AI is stateless and otherwise has no clock, so we inject the current time
// plus a *compact* digest of recent activity + upcoming deadlines. Raw events
// are never sent — only these aggregates (built in main/activity.ts) — so the
// block stays small. The deeper 30-day breakdown is only present when the
// question looked temporal (see isTemporalQuery).

/** Matches questions where knowing the date / recent history actually helps, so
 *  we only pay for the larger digest when it's worth it. */
const TEMPORAL_RE =
  /\b(yesterday|today|tonight|this morning|this week|last week|this month|last month|earlier|recently|ago|since|lately|when did|what did i|how (?:much|long|many)\b[^?]*\b(?:left|until|before|remaining|have|take)|deadline|overdue|due\b|schedule|this year|last year|past (?:few )?(?:days|weeks|months)|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|in (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

export function isTemporalQuery(text: string): boolean {
  return TEMPORAL_RE.test(text);
}

function activityLine(items: ActivityItem[]): string {
  return items.map((i) => `${i.verb} "${i.title}"`).join(", ");
}

/** Build the time + activity + deadlines context block appended to the system
 *  prompt. Always includes the clock; other sections appear only when non-empty. */
export function timeContext(ctx: ActivityContextPayload, now: Date = new Date()): string {
  const lines: string[] = [
    `Current date & time: ${now.toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}.`,
  ];

  const recent: string[] = [];
  if (ctx.today.length) recent.push(`Today — ${activityLine(ctx.today)}.`);
  if (ctx.yesterday.length) recent.push(`Yesterday — ${activityLine(ctx.yesterday)}.`);
  if (ctx.weekTop.length) {
    const top = ctx.weekTop.map((w) => `"${w.title}" (${w.edits} edits)`).join(", ");
    recent.push(`Most active this week: ${top}.`);
  }
  if (recent.length) lines.push(`Recent activity: ${recent.join(" ")}`);

  if (ctx.recentDays.length) {
    const days = ctx.recentDays.map((d) => `${d.day}: ${activityLine(d.items)}`).join(" | ");
    lines.push(`Earlier (last 30 days): ${days}`);
  }

  if (ctx.deadlines.length) {
    const dl = ctx.deadlines
      .map((d) => {
        const when =
          d.daysLeft < 0
            ? `${Math.abs(d.daysLeft)} day${Math.abs(d.daysLeft) === 1 ? "" : "s"} overdue`
            : d.daysLeft === 0
              ? "due today"
              : `${d.daysLeft} day${d.daysLeft === 1 ? "" : "s"} left`;
        return `"${d.title}" — due ${d.due} (${when})`;
      })
      .join("; ");
    lines.push(`Upcoming deadlines (from note \`due:\` dates): ${dl}.`);
  }

  lines.push(
    "Use this context only when the question is about time, schedule, or what the user has worked on; otherwise ignore it and don't mention it.",
  );
  return `\n\n${lines.join("\n")}`;
}

export interface PageAction {
  id: string;
  label: string;
  /** Lucide-ish icon key handled by the panel's icon switch. */
  icon: string;
  /** Produces the user-visible prompt sent as the chat message. */
  prompt: string;
  /** Whether this action needs the current note. */
  needsNote: boolean;
}

// The Notion-style "Do anything with AI" page actions.
export const PAGE_ACTIONS: PageAction[] = [
  {
    id: "summarize",
    label: "Summarize this page",
    icon: "summary",
    prompt: "Summarize this note in 3–5 concise bullet points.",
    needsNote: true,
  },
  {
    id: "improve",
    label: "Improve writing",
    icon: "wand",
    prompt:
      "Rewrite this note to improve clarity, flow, and grammar. Keep my meaning and Markdown structure. Return only the rewritten note.",
    needsNote: true,
  },
  {
    id: "action-items",
    label: "Find action items",
    icon: "check",
    prompt: "Extract any action items or to-dos from this note as a Markdown checklist.",
    needsNote: true,
  },
  {
    id: "translate",
    label: "Translate to English",
    icon: "translate",
    prompt: "Translate this note to English. Preserve Markdown formatting. Return only the translation.",
    needsNote: true,
  },
];

// ---- Vault skills (agent operations) ---------------------------------------
// Unlike page actions (single-turn prompts), a skill runs a real tool-using
// agent in the main process that edits the vault — sandboxed to wiki/, index.md
// and log.md (see main/agentOps.ts). Karpathy-pattern operations: Ingest, Lint.

export interface VaultSkill {
  id: "ingest" | "lint";
  label: string;
  icon: string;
  /** One-line explanation shown in the skills menu. */
  description: string;
  /** Needs an open note (the ingest target). */
  needsNote?: boolean;
  /** The user-visible line logged into the chat when the skill runs. */
  turnLabel: string;
}

export const VAULT_SKILLS: VaultSkill[] = [
  {
    id: "ingest",
    label: "Ingest this page",
    icon: "ingest",
    description: "File this note into the wiki: pages, cross-links, index and log.",
    needsNote: true,
    turnLabel: "Ingest this page into the wiki",
  },
  {
    id: "lint",
    label: "Lint my wiki",
    icon: "lint",
    description: "Health-check: contradictions, stale claims, orphans, missing links.",
    turnLabel: "Lint the wiki",
  },
];

/** Shown when a skill is invoked on a provider that can't run agent ops. */
export const SKILLS_NEED_CLAUDE =
  "Vault skills (Ingest / Lint) run a tool-using agent, which needs **Claude** (the Pro/Max " +
  "subscription or an Anthropic API key). Your current provider still powers chat; switch " +
  "providers in Settings to use skills.";

// Suggestions shown when no note is open — these search across the vault.
export const ASK_SUGGESTIONS: string[] = [
  "What did I write about this week?",
  "Find my notes about projects",
  "What are my open to-dos?",
];

// ---- Inline AI (selection toolbar) ----------------------------------------
// The "Ask AI" skills in the floating selection toolbar. Each action turns the
// highlighted passage into a new one; the result streams into a preview card
// the user can Replace / Insert / Discard, so nothing edits the note until they
// accept it. Kept declarative so the catalog reads at a glance.

export interface InlineAiVariant {
  id: string;
  label: string;
  instruction: string;
}

export interface InlineAiAction {
  id: string;
  label: string;
  /** Icon key resolved by SelectionMenu's local lucide map. */
  icon: string;
  /** Fixed instruction, or omitted when the action has `variants`/`custom`. */
  instruction?: string;
  /** Sub-options (target tone / language) each carrying their own instruction. */
  variants?: InlineAiVariant[];
  /** The free-form "Ask AI…" entry that takes a typed instruction. */
  custom?: boolean;
  /** 'replace' emphasises "Replace"; 'generate' emphasises "Insert below". */
  mode: "replace" | "generate";
}

export const INLINE_AI_ACTIONS: InlineAiAction[] = [
  {
    id: "improve",
    label: "Improve writing",
    icon: "improve",
    instruction: "Rewrite the text to improve clarity, flow, and grammar while keeping its meaning.",
    mode: "replace",
  },
  {
    id: "grammar",
    label: "Fix spelling & grammar",
    icon: "grammar",
    instruction: "Correct any spelling and grammar mistakes. Change nothing else.",
    mode: "replace",
  },
  {
    id: "shorter",
    label: "Make shorter",
    icon: "shorter",
    instruction: "Make the text more concise while keeping the key points.",
    mode: "replace",
  },
  {
    id: "longer",
    label: "Make longer",
    icon: "longer",
    instruction: "Expand the text with more detail and explanation, keeping the same intent and tone.",
    mode: "replace",
  },
  {
    id: "tone",
    label: "Change tone",
    icon: "tone",
    mode: "replace",
    variants: [
      { id: "professional", label: "Professional", instruction: "Rewrite the text in a professional tone." },
      { id: "casual", label: "Casual", instruction: "Rewrite the text in a casual, relaxed tone." },
      { id: "confident", label: "Confident", instruction: "Rewrite the text in a confident, assertive tone." },
      { id: "friendly", label: "Friendly", instruction: "Rewrite the text in a warm, friendly tone." },
    ],
  },
  {
    id: "translate",
    label: "Translate",
    icon: "translate",
    mode: "replace",
    variants: [
      { id: "en", label: "English", instruction: "Translate the text to English." },
      { id: "es", label: "Spanish", instruction: "Translate the text to Spanish." },
      { id: "fr", label: "French", instruction: "Translate the text to French." },
      { id: "de", label: "German", instruction: "Translate the text to German." },
      { id: "zh", label: "Chinese", instruction: "Translate the text to Chinese." },
      { id: "ja", label: "Japanese", instruction: "Translate the text to Japanese." },
    ],
  },
  {
    id: "ask",
    label: "Ask AI to edit…",
    icon: "ask",
    custom: true,
    mode: "replace",
  },
];

/** System persona for the inline rewrite: return only the transformed text. */
export function inlineRewriteSystem(): string {
  return [
    "You are KestraVault AI, an inline writing assistant inside a markdown notes app.",
    "The user selected a passage in their note and chose an action to apply to it.",
    "Apply the instruction and return ONLY the resulting text — no preamble, no explanation,",
    "no surrounding quotes and no code fences.",
    "Preserve the user's Markdown formatting and language unless the instruction says otherwise.",
  ].join(" ");
}

/** The user message: the instruction plus the selected passage, delimited. */
export function inlineRewritePrompt(instruction: string, selection: string): string {
  return `${instruction.trim()}\n\nText:\n"""\n${selection}\n"""`;
}
