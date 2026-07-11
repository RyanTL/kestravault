// The "brain" of a vault: the onboarding profile plus the AI guide it generates.
//
// Onboarding collects a BrainProfile; this module turns it into:
//   .kestravault/instructions.md  — the AI guide: purpose, working rules, and the
//                                   vault map (an index the AI keeps current so it
//                                   can navigate without scanning every file)
//   .kestravault/config.json      — the profile + onboarding state
//   the folder scaffold the user picked
//
// There is no imposed structure: the folders, the filing rules, and the map all
// come from the user's answers (or their own edits — the guide is plain markdown,
// editable in Settings → AI guide). The template output is the fallback; an AI
// pass may rewrite it into something more personal (see enhancePrompt).

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
  /** Top-level folders to scaffold — the user's structure, not a preset one. */
  folders: string[];
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
  /** Default folder suggestions for this purpose (freely editable). */
  folders: string[];
}

export const PURPOSES: PurposeOption[] = [
  {
    id: "research",
    label: "Research a topic",
    description: "Papers, articles and reports on a subject, building an evolving picture.",
    folders: ["research", "reading", "notes", "archive"],
  },
  {
    id: "personal",
    label: "Personal knowledge",
    description: "Goals, health, journal entries, articles. A structured picture of your life.",
    folders: ["journal", "people", "notes", "archive"],
  },
  {
    id: "reading",
    label: "Reading companion",
    description: "Books and long reads. Track characters, themes and threads as you go.",
    folders: ["reading", "notes", "ideas"],
  },
  {
    id: "work",
    label: "Work & projects",
    description: "Meetings, documents, decisions and the people/projects behind them.",
    folders: ["projects", "people", "notes", "archive"],
  },
  {
    id: "mixed",
    label: "A bit of everything",
    description: "A general second brain. The structure evolves with what you add.",
    folders: ["notes", "projects", "ideas", "archive"],
  },
];

/** What each suggested folder is for — folds into the guide's vault map. */
export const FOLDER_INFO: Record<string, string> = {
  notes: "quick notes and anything not yet categorized",
  projects: "one note or subfolder per active project",
  people: "one note per person — who they are, context, threads",
  journal: "dated entries — days, weeks, reflections",
  reading: "books, articles, and highlights",
  research: "papers, findings, and open questions",
  resources: "reference material worth keeping",
  ideas: "sparks, drafts, and someday/maybe",
  archive: "finished or inactive material — moved here instead of deleted",
};

export const FOLDER_CHOICES = Object.keys(FOLDER_INFO);

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
    folders: purposeOf("mixed").folders,
  };
}

// ── Paths ────────────────────────────────────────────────────────────────────

export const INSTRUCTIONS_PATH = ".kestravault/instructions.md";
export const BRAIN_CONFIG_PATH = ".kestravault/config.json";
export const SKILLS_PATH = ".kestravault/skills.json";

/** Folders the setup creates (vault-relative) — exactly what the user picked. */
export function scaffoldDirs(profile: BrainProfile): string[] {
  return profile.folders.length ? [...profile.folders] : ["notes"];
}

// ── Template builders ────────────────────────────────────────────────────────

function styleLine(profile: BrainProfile): string {
  const voice =
    profile.style === "concise"
      ? "Write tightly: short paragraphs, atomic bullets, no filler."
      : "Write in clear, well-developed prose. Explain reasoning and context, not just conclusions.";
  const lang = profile.language
    ? `Write answers and notes in ${profile.language}.`
    : "Match the language the user writes their notes in.";
  return `${voice} ${lang}`;
}

function filingLine(profile: BrainProfile): string {
  return profile.ingestMode === "guided"
    ? "Before reorganizing or filing notes, tell the user what you plan to change and incorporate their emphasis."
    : "File and organize notes directly, then summarize what changed so the user can review.";
}

function folderLines(profile: BrainProfile): string {
  const folders = profile.folders.length ? profile.folders : ["notes"];
  return folders
    .map((f) => `- \`${f}/\` — ${FOLDER_INFO[f] ?? "(describe what belongs here)"}`)
    .join("\n");
}

/** The AI guide written to `.kestravault/instructions.md`. Short on purpose:
 *  the AI reads it in full before every operation, so every line must earn
 *  its place — and the Vault map is what saves it from scanning every file. */
export function buildInstructions(profile: BrainProfile, vaultName: string): string {
  const purpose = purposeOf(profile.purpose);
  const about = profile.about.trim() ? profile.about.trim() : "_(not provided yet)_";
  const topics = profile.topics.trim() ? ` Focus areas: ${profile.topics.trim()}.` : "";

  return `# ${vaultName} — AI guide

_The AI reads this file first, before every chat and vault operation. Keep it short and
current. You can edit it anytime (Settings → AI guide); the AI keeps the **Vault map**
section accurate so it can find anything without scanning every file._

## Purpose
${purpose.label}: ${purpose.description}${topics}

## About the user
${about}

## How to work
- Ground answers in the notes in this vault and cite note titles; if the notes don't cover it, say so.
- ${styleLine(profile)}
- ${filingLine(profile)}
- Link related notes with \`[[wikilinks]]\`, using note titles.
- Prefer moving or renaming notes over deleting; never discard the user's words.
- Use the Vault map below to navigate. After any change that adds, moves, renames, or
  reorganizes notes, update the Vault map so it stays true.

## Vault map
_The index of this vault: each folder, what belongs in it, and the notes worth knowing
about. One line per entry — enough to find everything, short enough to read every time._

${folderLines(profile)}

_(No notes yet — extend this map as content arrives.)_

## Learned preferences
_Corrections and preferences that should shape future work. Keep entries short._
- (none yet)
`;
}

// ── AI personalization ───────────────────────────────────────────────────────

/** System prompt for the enhancement pass that rewrites the template. */
export function enhanceSystem(): string {
  return [
    "You are configuring the guide file for a personal, AI-assisted notes vault.",
    "You will receive the user's onboarding answers and a template guide file.",
    "Rewrite the guide so it is genuinely personalized: fold the user's purpose, topics",
    "and background into the Purpose/About sections, tailor the working rules and the",
    "folder structure in the Vault map to their domain (you may rename, add, or drop",
    "folders if the answers suggest a better structure), and keep every section heading",
    "from the template. The Vault map must list each folder with a one-line description.",
    "Keep the file under 80 lines — the AI reads it in full on every operation.",
    "Return ONLY the final markdown file content — no preamble, no explanation, no code fences.",
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
    `Filing mode: ${profile.ingestMode === "guided" ? "discuss before changing things" : "organize automatically"}`,
    `Folders: ${profile.folders.join(", ")}`,
  ].join("\n");
  return `The user's onboarding answers:\n${answers}\n\nThe template to personalize:\n"""\n${template}\n"""`;
}

/** Cheap sanity check that an AI enhancement is a usable guide file. */
export function looksLikeInstructions(text: string): boolean {
  const t = text.trim();
  return t.startsWith("#") && /\n## /.test(t) && t.length > 300;
}

// ── Chat personalization ─────────────────────────────────────────────────────

const BRAIN_CONTEXT_LIMIT = 6000;

/** Wrap instructions.md as a system-prompt block for the in-app assistant. */
export function brainContext(instructions: string): string {
  let text = instructions.trim();
  if (!text) return "";
  if (text.length > BRAIN_CONTEXT_LIMIT) text = text.slice(0, BRAIN_CONTEXT_LIMIT) + "\n…";
  return (
    `\n\nThis vault has a personalized AI guide (its purpose, working rules, and the map` +
    ` of its structure). Follow it in everything you do here:\n\n"""\n${text}\n"""`
  );
}

// ── Config + apply (renderer-side, via the vault IPC) ────────────────────────

export async function readBrainConfig(): Promise<BrainConfig | null> {
  try {
    const raw = await window.api.vault.read(BRAIN_CONFIG_PATH);
    const parsed = JSON.parse(raw) as Partial<BrainConfig> & {
      profile?: Partial<BrainProfile> & { categories?: string[] };
    };
    if (parsed.onboarding === "done" || parsed.onboarding === "skipped") {
      // Older configs stored wiki categories; carry them over as folders so a
      // wizard re-run prefills something sensible.
      let profile: BrainProfile | undefined;
      if (parsed.profile) {
        const p = parsed.profile;
        profile = {
          ...defaultProfile(),
          ...p,
          folders: p.folders ?? p.categories ?? defaultProfile().folders,
        };
      }
      return {
        version: 1,
        onboarding: parsed.onboarding,
        aiPersonalized: parsed.aiPersonalized ?? false,
        completedAt: parsed.completedAt ?? "",
        profile,
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
 * Lay the brain down onto the current vault: scaffold the chosen folders and
 * write the AI guide. Non-destructive by design — existing folders and notes
 * are kept, while instructions.md is always (re)written because onboarding is
 * the authoritative editor for it.
 */
export async function applyBrainSetup(
  profile: BrainProfile,
  vaultName: string,
  opts: { aiInstructions?: string } = {},
): Promise<ApplyBrainResult> {
  const wrote: string[] = [];
  const kept: string[] = [];
  const existing = flattenTree(await window.api.vault.tree());

  // Folders: createDir auto-suffixes on collision ("notes 2"), so only create
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
  void kept;

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
