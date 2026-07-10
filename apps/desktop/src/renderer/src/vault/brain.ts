// The "brain" of a vault: the onboarding profile plus the generated system
// files that make the AI a disciplined wiki maintainer instead of a generic
// chatbot (Karpathy's "schema" layer — see plan/data-model.md).
//
// Onboarding collects a BrainProfile; this module turns it into:
//   .kestravault/instructions.md  — the master schema the AI reads on every run
//   .kestravault/config.json      — the profile + onboarding state
//   AGENTS.md / CLAUDE.md     — thin stubs so external agents (Codex/ChatGPT,
//                               Claude Code) opened *in the vault folder* follow
//                               the same rules as the built-in assistant
//   folder scaffold + index.md / log.md when missing
//
// Everything is a plain markdown/JSON file the user can read and edit — the
// template output is the fallback, and an AI pass may rewrite instructions.md
// into something more personal (see enhanceInstructionsPrompt).

export type BrainPurpose = "research" | "personal" | "reading" | "work" | "mixed";
export type BrainStyle = "concise" | "detailed";
export type IngestMode = "guided" | "auto";

export interface BrainProfile {
  purpose: BrainPurpose;
  /** Topics / domains the user plans to feed it (free text). */
  topics: string;
  /** Who the user is — role, background, what they care about (free text). */
  about: string;
  style: BrainStyle;
  /** Preferred answer language; "" = match the language of the notes. */
  language: string;
  ingestMode: IngestMode;
  /** wiki/ subfolders to scaffold (controlled page categories). */
  categories: string[];
}

export interface BrainConfig {
  version: 1;
  onboarding: "done" | "skipped";
  /** True when instructions.md was AI-written (vs the plain template). */
  aiPersonalized: boolean;
  completedAt: string;
  profile?: BrainProfile;
}

export interface PurposeOption {
  id: BrainPurpose;
  label: string;
  description: string;
  /** Default wiki categories for this purpose. */
  categories: string[];
}

export const PURPOSES: PurposeOption[] = [
  {
    id: "research",
    label: "Research a topic",
    description: "Papers, articles and reports on a subject, building an evolving thesis.",
    categories: ["concepts", "entities", "topics", "sources"],
  },
  {
    id: "personal",
    label: "Personal knowledge",
    description: "Goals, health, journal entries, articles. A structured picture of your life.",
    categories: ["topics", "people", "sources"],
  },
  {
    id: "reading",
    label: "Reading companion",
    description: "Books and long reads. Track characters, themes and threads as you go.",
    categories: ["books", "characters", "themes", "sources"],
  },
  {
    id: "work",
    label: "Work & projects",
    description: "Meetings, documents, decisions and the people/projects behind them.",
    categories: ["projects", "people", "concepts", "sources"],
  },
  {
    id: "mixed",
    label: "A bit of everything",
    description: "A general second brain. The structure evolves with what you add.",
    categories: ["concepts", "entities", "topics", "sources"],
  },
];

export const CATEGORY_CHOICES = [
  "concepts",
  "entities",
  "topics",
  "sources",
  "people",
  "projects",
  "books",
  "characters",
  "themes",
];

export const LANGUAGE_CHOICES = ["", "English", "Spanish", "French", "German", "Portuguese"];

export function purposeOf(id: BrainPurpose): PurposeOption {
  return PURPOSES.find((p) => p.id === id) ?? PURPOSES[PURPOSES.length - 1]!;
}

export function defaultProfile(): BrainProfile {
  return {
    purpose: "mixed",
    topics: "",
    about: "",
    style: "concise",
    language: "",
    ingestMode: "guided",
    categories: purposeOf("mixed").categories,
  };
}

// ── Paths ────────────────────────────────────────────────────────────────────

export const INSTRUCTIONS_PATH = ".kestravault/instructions.md";
export const BRAIN_CONFIG_PATH = ".kestravault/config.json";

/** Folders the brain scaffold creates (vault-relative). */
export function scaffoldDirs(profile: BrainProfile): string[] {
  const cats = profile.categories.length ? profile.categories : ["concepts", "sources"];
  return ["sources", "sources/assets", ...cats.map((c) => `wiki/${c}`), "notes"];
}

// ── Template builders ────────────────────────────────────────────────────────

const today = (): string => new Date().toISOString().slice(0, 10);

function styleLine(profile: BrainProfile): string {
  const voice =
    profile.style === "concise"
      ? "Write tightly: short paragraphs, atomic bullets, no filler. Prefer a bullet over a sentence when both work."
      : "Write in clear, well-developed prose. Explain reasoning and context, not just conclusions.";
  const lang = profile.language
    ? `Write wiki pages and answers in ${profile.language}.`
    : "Match the language the user writes their notes in.";
  return `${voice} ${lang}`;
}

function ingestModeLines(profile: BrainProfile): string {
  return profile.ingestMode === "guided"
    ? [
        "- **Guided mode:** before filing, give the user a short digest of the source's key takeaways",
        "  and what you plan to update; incorporate their emphasis. Stay conversational — the user",
        "  wants to be involved in what gets filed.",
      ].join("\n")
    : [
        "- **Auto mode:** file sources directly without waiting for discussion. Summarize what you",
        "  changed at the end so the user can review the change feed.",
      ].join("\n");
}

/** The master schema written to `.kestravault/instructions.md`. */
export function buildInstructions(profile: BrainProfile, vaultName: string): string {
  const purpose = purposeOf(profile.purpose);
  const cats = profile.categories.length ? profile.categories : purpose.categories;
  const aboutBlock = [
    profile.about.trim() ? profile.about.trim() : "_(not provided yet)_",
    profile.topics.trim() ? `\nTopics they plan to feed this brain: ${profile.topics.trim()}.` : "",
  ].join("");

  return `# ${vaultName} — Brain instructions

_This file is the schema for the AI that maintains this vault. The AI reads it at the start of
every operation and follows it exactly. Only the human edits this file — the AI may **propose**
changes (see “Improving these instructions”) but never rewrites it itself._

## Purpose
${purpose.label}: ${purpose.description}
${profile.topics.trim() ? `Focus areas: ${profile.topics.trim()}.` : ""}

## About the user
${aboutBlock}

## Layout & zones
| Zone | Owner | AI access |
|---|---|---|
| \`sources/\` | human drops raw material | **read-only — never modify or delete** |
| \`wiki/\` | AI-maintained knowledge | read/write — your primary work area |
| \`notes/\` | human's own notes | read-only unless explicitly asked to edit |
| \`index.md\` | catalog of the wiki | read/write — keep current on every change |
| \`log.md\` | append-only operation log | append one entry per operation |
| \`.kestravault/\` | app metadata & this file | **read-only** |

Wiki pages live under: ${cats.map((c) => `\`wiki/${c}/\``).join(", ")}.

## Page conventions
- One concept/entity per page; keep pages small and atomic.
- Filenames are readable slugs; new sources are \`sources/s-YYYY-MM-DD-<slug>.md\`.
- Cross-reference with \`[[wikilinks]]\` inline in prose, using the page title (never an id).
- Every wiki page starts with YAML frontmatter: \`title\`, \`type\`, one-line \`summary\`,
  \`aliases\` (natural alternative names), \`tags\` (see vocabulary below), \`sources\` (provenance),
  \`created\`/\`updated\` dates.
- Page shape: \`# Title\` → one-line summary → \`## Key facts\` (atomic bullets) →
  \`## Details\` (prose with [[links]]) → \`## Sources\`.

## Workflows
### Ingest (file a source into the wiki)
1. Read the source fully. Read \`index.md\` to see what already exists.
${ingestModeLines(profile)}
3. Write/refresh the per-source summary page in \`wiki/sources/\` (or the closest category).
4. Update every wiki page the source touches: add facts, cross-references, and note where the
   new material **contradicts or supersedes** existing claims (say so explicitly on the page).
5. Update \`index.md\` (one line per page: link, summary, tags).
6. Append to \`log.md\`: \`## [YYYY-MM-DD] ingest | <source title>\` plus a short list of pages touched.

### Query (answer from the wiki)
1. Read \`index.md\` first to find candidate pages; open only what's relevant.
2. Ground answers in wiki/source pages and cite page titles. If the wiki doesn't cover it, say so.
3. When an answer produces something durable (a comparison, an analysis, a connection), offer to
   file it back into the wiki as a new page.

### Lint (health check)
1. Scan for: contradictions between pages, stale claims superseded by newer sources, orphan pages
   with no inbound links, concepts mentioned often but lacking a page, missing cross-references,
   index entries that drifted from the pages.
2. Fix the mechanical problems directly (index drift, missing links, orphan wiring).
3. Report the judgment calls (contradictions, gaps, suggested new sources or questions) to the user.
4. Append a \`lint\` entry to \`log.md\`.

## Style
${styleLine(profile)}

## Tag vocabulary
Keep tags to a small controlled set so retrieval doesn't fragment. Current set (grow deliberately):
_(none yet — add tags here as they emerge)_

## Learned preferences
_The user's corrections and preferences accumulate here over time so every future run improves.
The AI may **suggest** additions in its summaries; the human adds them._
- (none yet)

## Improving these instructions
After an ingest or lint, if you noticed a way this schema could work better for this user
(a missing category, a recurring correction, a better page shape), **propose it in your summary**.
Never edit this file yourself.
`;
}

/** AGENTS.md — makes the vault work with Codex/ChatGPT-style agents (and any
 *  tool that follows the AGENTS.md convention) opened directly in the folder. */
export function buildAgentsMd(vaultName: string): string {
  return `# AGENTS.md — ${vaultName}

This folder is an **KestraVault vault**: a personal knowledge base where an AI maintains an
interlinked markdown wiki from raw sources (the "LLM Wiki" pattern).

**Read \`.kestravault/instructions.md\` first and follow it exactly** — it is the single source of
truth for this vault's structure, workflows (ingest / query / lint), and style.

Non-negotiable rules, whatever agent you are:
- \`sources/\` is immutable — never modify or delete anything in it.
- \`notes/\` belongs to the human — read it, but only edit when explicitly asked.
- \`wiki/\`, \`index.md\` and \`log.md\` are yours to maintain; keep them consistent.
- Never rewrite \`.kestravault/\` (including \`instructions.md\`) — propose changes instead.
`;
}

/** CLAUDE.md — points Claude Code at AGENTS.md so all tools share one ruleset. */
export function buildClaudeMd(): string {
  return `# CLAUDE.md

This vault uses **\`AGENTS.md\`** as the shared ruleset for every AI agent, so Claude Code,
Codex, and others stay in sync. Read \`./AGENTS.md\`, then \`.kestravault/instructions.md\`.
`;
}

export function buildIndexMd(vaultName: string): string {
  return `---
title: Index
type: index
---

# Index

The catalog of everything in **${vaultName}** — maintained by the AI, one line per wiki page.
Drop material into \`sources/\` and run **Ingest** to grow it.

_(empty — nothing ingested yet)_
`;
}

export function buildLogMd(): string {
  return `---
title: Log
type: log
---

# Log

Append-only record of every operation on this vault, newest last.

## [${today()}] setup | Brain created
Vault scaffolded from onboarding; instructions written to \`.kestravault/instructions.md\`.
`;
}

// ── AI personalization ───────────────────────────────────────────────────────

/** System prompt for the enhancement pass that rewrites the template. */
export function enhanceSystem(): string {
  return [
    "You are configuring a personal AI-maintained knowledge base (an 'LLM wiki').",
    "You will receive the user's onboarding answers and a template instruction file.",
    "Rewrite the instruction file so it is genuinely personalized: fold the user's purpose,",
    "topics and background into the Purpose/About sections, tailor the workflows and page",
    "categories to their domain, and seed a starter tag vocabulary from their topics.",
    "Keep every section heading and every permission rule from the template — the zone table",
    "and the 'never edit sources/ or .kestravault/' rules must survive verbatim in meaning.",
    "Keep it under 150 lines. Return ONLY the final markdown file content —",
    "no preamble, no explanation, no code fences.",
  ].join(" ");
}

/** User message for the enhancement pass. */
export function enhancePrompt(profile: BrainProfile, template: string): string {
  const purpose = purposeOf(profile.purpose);
  const answers = [
    `Purpose: ${purpose.label} — ${purpose.description}`,
    `Topics/domains: ${profile.topics.trim() || "(none given)"}`,
    `About the user: ${profile.about.trim() || "(none given)"}`,
    `Writing style: ${profile.style === "concise" ? "concise bullets" : "detailed prose"}`,
    `Language: ${profile.language || "match the notes"}`,
    `Ingest mode: ${profile.ingestMode === "guided" ? "discuss before filing" : "file automatically"}`,
    `Wiki categories: ${profile.categories.join(", ")}`,
  ].join("\n");
  return `The user's onboarding answers:\n${answers}\n\nThe template to personalize:\n"""\n${template}\n"""`;
}

/** Cheap sanity check that an AI enhancement is a usable instructions file. */
export function looksLikeInstructions(text: string): boolean {
  const t = text.trim();
  return t.startsWith("#") && /sources\//.test(t) && /wiki\//.test(t) && t.length > 400;
}

// ── Chat personalization ─────────────────────────────────────────────────────

const BRAIN_CONTEXT_LIMIT = 6000;

/** Wrap instructions.md as a system-prompt block for the in-app assistant. */
export function brainContext(instructions: string): string {
  let text = instructions.trim();
  if (!text) return "";
  if (text.length > BRAIN_CONTEXT_LIMIT) text = text.slice(0, BRAIN_CONTEXT_LIMIT) + "\n…";
  return (
    `\n\nThis vault has personalized brain instructions (its schema). Follow them — especially` +
    ` the zone permissions, style, and workflows — in everything you do here:\n\n"""\n${text}\n"""`
  );
}

// ── Config + apply (renderer-side, via the vault IPC) ────────────────────────

export async function readBrainConfig(): Promise<BrainConfig | null> {
  try {
    const raw = await window.api.vault.read(BRAIN_CONFIG_PATH);
    const parsed = JSON.parse(raw) as Partial<BrainConfig>;
    if (parsed.onboarding === "done" || parsed.onboarding === "skipped") {
      return {
        version: 1,
        onboarding: parsed.onboarding,
        aiPersonalized: parsed.aiPersonalized ?? false,
        completedAt: parsed.completedAt ?? "",
        profile: parsed.profile,
      };
    }
    return null;
  } catch {
    return null; // missing or unreadable → treat as "no onboarding yet"
  }
}

export async function writeBrainConfig(cfg: BrainConfig): Promise<void> {
  await window.api.vault.write(BRAIN_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export interface ApplyBrainResult {
  /** Vault-relative files written. */
  wrote: string[];
  /** Files left untouched because they already existed. */
  kept: string[];
}

/** Every path (files + dirs) currently in the vault tree, as a set. */
function flattenTree(nodes: { path: string; kind: string; children?: unknown }[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: typeof nodes): void => {
    for (const n of list) {
      out.add(n.path);
      if (Array.isArray(n.children)) walk(n.children as typeof nodes);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Lay the brain down onto the current vault: scaffold folders, write the
 * instruction files, and create index/log when missing. Non-destructive by
 * design — existing index.md / log.md / AGENTS.md / CLAUDE.md are kept (they
 * may be the user's own), while instructions.md is always (re)written because
 * onboarding is the authoritative editor for it.
 */
export async function applyBrainSetup(
  profile: BrainProfile,
  vaultName: string,
  opts: { aiInstructions?: string } = {},
): Promise<ApplyBrainResult> {
  const wrote: string[] = [];
  const kept: string[] = [];
  const existing = flattenTree(await window.api.vault.tree());

  // Folders: createDir auto-suffixes on collision ("sources 2"), so only create
  // the ones that don't exist yet.
  for (const dir of scaffoldDirs(profile)) {
    if (!existing.has(dir)) await window.api.vault.createDir(dir);
  }

  const instructions =
    opts.aiInstructions && looksLikeInstructions(opts.aiInstructions)
      ? opts.aiInstructions.trim() + "\n"
      : buildInstructions(profile, vaultName);
  await window.api.vault.write(INSTRUCTIONS_PATH, instructions);
  wrote.push(INSTRUCTIONS_PATH);

  const writeIfMissing = async (path: string, content: string): Promise<void> => {
    if (existing.has(path)) {
      kept.push(path);
      return;
    }
    await window.api.vault.write(path, content);
    wrote.push(path);
  };
  // The tree hides root dotfiles but AGENTS/CLAUDE/index/log are visible files;
  // AGENTS.md and CLAUDE.md may exist in an opened folder (someone's own setup).
  await writeIfMissing("AGENTS.md", buildAgentsMd(vaultName));
  await writeIfMissing("CLAUDE.md", buildClaudeMd());
  await writeIfMissing("index.md", buildIndexMd(vaultName));
  await writeIfMissing("log.md", buildLogMd());

  await writeBrainConfig({
    version: 1,
    onboarding: "done",
    aiPersonalized: !!(opts.aiInstructions && looksLikeInstructions(opts.aiInstructions)),
    completedAt: new Date().toISOString(),
    profile,
  });

  return { wrote, kept };
}

/** Record that the user skipped onboarding for this vault (don't re-ask). */
export async function skipBrainSetup(): Promise<void> {
  await writeBrainConfig({
    version: 1,
    onboarding: "skipped",
    aiPersonalized: false,
    completedAt: new Date().toISOString(),
  });
}
