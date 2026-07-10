import { app, shell } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultRoot, readTree, readFile, type VaultNode } from "./vault.js";

// ── Activity log ─────────────────────────────────────────────────────────────
// A local, app-private record of what the user does in the vault (opens, edits,
// creates, renames, deletes, and AI questions). It is deliberately NOT part of
// the markdown vault — the vault stays Obsidian-clean — so it lives in userData
// alongside vaults.json / secrets.json, as append-only JSONL (one event/line,
// so high-frequency appends never rewrite the whole file).
//
// The point of the log is to make the AI aware of time + recent work without
// bloating its context: raw events are never sent to the model. `activityContext`
// reads the log and returns only small aggregated digests, and the renderer
// only asks for the larger (deep) digest when a question looks temporal.
//
// Privacy: we store paths, titles, timestamps, and (for `ask`) a truncated
// question — never note bodies. The user can pause tracking or clear the log
// from Settings.

export type ActivityType = "open" | "edit" | "create" | "rename" | "delete" | "ask";

/** What the renderer sends; `ts` + `vault` are stamped here. */
export interface ActivityEventInput {
  type: ActivityType;
  path: string;
  title?: string;
  /** Truncated question text — only set for `ask` events. */
  note?: string;
}

interface ActivityEvent extends ActivityEventInput {
  ts: number;
  vault: string;
}

// Keep the file (and every scan of it) bounded regardless of how long the app
// runs: drop anything older than ~180 days and keep at most this many lines.
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_LINES = 10_000;

// Deadlines rarely change between two questions asked seconds apart — cache the
// vault scan briefly so rapid asks don't re-read every file.
const DEADLINE_TTL_MS = 15_000;

function activityFile(): string {
  return join(app.getPath("userData"), "activity.jsonl");
}

// ── Recording ────────────────────────────────────────────────────────────────

/** Append one event. Fire-and-forget: logging must never break a user action. */
export async function recordEvent(input: ActivityEventInput): Promise<void> {
  try {
    const evt: ActivityEvent = {
      ts: Date.now(),
      vault: vaultRoot(),
      type: input.type,
      path: input.path,
      ...(input.title ? { title: input.title } : {}),
      ...(input.note ? { note: input.note.slice(0, 120) } : {}),
    };
    await fs.appendFile(activityFile(), JSON.stringify(evt) + "\n", "utf8");
  } catch {
    /* best-effort — a lost activity line is never worth surfacing an error */
  }
}

// ── Reading & pruning ────────────────────────────────────────────────────────

let pruned = false;

/** Parse every event in the file (all vaults). Skips malformed lines. */
async function readEvents(): Promise<ActivityEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(activityFile(), "utf8");
  } catch {
    return [];
  }
  const events: ActivityEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed) as ActivityEvent;
      if (evt && typeof evt.ts === "number" && typeof evt.path === "string") events.push(evt);
    } catch {
      /* skip a corrupt line */
    }
  }
  // Rewrite the trimmed file at most once per process, and only when it has
  // actually grown past the caps — normal reads stay read-only.
  if (!pruned) {
    pruned = true;
    const cutoff = Date.now() - MAX_AGE_MS;
    const kept = events.filter((e) => e.ts >= cutoff).slice(-MAX_LINES);
    if (kept.length !== events.length) {
      try {
        await fs.writeFile(
          activityFile(),
          kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
          "utf8",
        );
      } catch {
        /* keep going with what we parsed */
      }
      return kept;
    }
  }
  return events;
}

// ── Digest aggregation ───────────────────────────────────────────────────────

export interface ActivityItem {
  title: string;
  verb: "created" | "edited" | "renamed" | "deleted" | "opened";
  path: string;
}
export interface ActivityDay {
  /** e.g. "Mon Jun 30" */
  day: string;
  items: ActivityItem[];
}
export interface WeekTopItem {
  title: string;
  edits: number;
}
export interface ActivityDeadline {
  title: string;
  path: string;
  /** ISO date (YYYY-MM-DD) as written in the note. */
  due: string;
  daysLeft: number;
}
export interface ActivityContextPayload {
  today: ActivityItem[];
  yesterday: ActivityItem[];
  weekTop: WeekTopItem[];
  /** Last ~30 days grouped by day — only populated when `deep` is requested. */
  recentDays: ActivityDay[];
  deadlines: ActivityDeadline[];
}

// Which verb wins when a note saw several kinds of event in one day.
const VERB_RANK: ActivityType[] = ["create", "edit", "rename", "delete", "open"];
const VERB_LABEL: Record<ActivityType, ActivityItem["verb"]> = {
  create: "created",
  edit: "edited",
  rename: "renamed",
  delete: "deleted",
  open: "opened",
  ask: "opened",
};

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function titleOf(evt: ActivityEvent): string {
  if (evt.title) return evt.title;
  const base = evt.path.slice(evt.path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "") || evt.path || "(untitled)";
}

/** Collapse a set of events into one item per note, choosing the strongest verb.
 *  Newest note first; `ask` events don't count as activity on their own. */
function bucketItems(events: ActivityEvent[], cap: number): ActivityItem[] {
  const byPath = new Map<string, { last: number; kinds: Set<ActivityType>; title: string }>();
  for (const e of events) {
    if (e.type === "ask") continue;
    const cur = byPath.get(e.path);
    if (cur) {
      cur.kinds.add(e.type);
      if (e.ts > cur.last) {
        cur.last = e.ts;
        cur.title = titleOf(e);
      }
    } else {
      byPath.set(e.path, { last: e.ts, kinds: new Set([e.type]), title: titleOf(e) });
    }
  }
  return [...byPath.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, cap)
    .map(([path, v]) => {
      const kind = VERB_RANK.find((k) => v.kinds.has(k)) ?? "open";
      return { title: v.title, verb: VERB_LABEL[kind], path };
    });
}

/** Aggregate the current vault's log into the small payload the prompt uses. */
export async function activityContext(opts: { deep?: boolean } = {}): Promise<ActivityContextPayload> {
  const all = await readEvents();
  const root = vaultRoot();
  const mine = all.filter((e) => e.vault === root);

  const todayStart = startOfDay(Date.now());
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const today = bucketItems(
    mine.filter((e) => e.ts >= todayStart),
    6,
  );
  const yesterday = bucketItems(
    mine.filter((e) => e.ts >= yesterdayStart && e.ts < todayStart),
    6,
  );

  // "Most active this week" — by number of edit/create events per note.
  const edits = new Map<string, { title: string; n: number }>();
  for (const e of mine) {
    if (e.ts < weekStart) continue;
    if (e.type !== "edit" && e.type !== "create") continue;
    const cur = edits.get(e.path);
    if (cur) cur.n += 1;
    else edits.set(e.path, { title: titleOf(e), n: 1 });
  }
  const weekTop: WeekTopItem[] = [...edits.values()]
    .filter((v) => v.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((v) => ({ title: v.title, edits: v.n }));

  let recentDays: ActivityDay[] = [];
  if (opts.deep) {
    const thirtyStart = todayStart - 30 * 24 * 60 * 60 * 1000;
    const byDay = new Map<number, ActivityEvent[]>();
    for (const e of mine) {
      // today + yesterday already have their own buckets — don't repeat them here.
      if (e.ts < thirtyStart || e.ts >= yesterdayStart) continue;
      const day = startOfDay(e.ts);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(e);
    }
    recentDays = [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, 14)
      .map(([day, evs]) => ({ day: dayLabel(day), items: bucketItems(evs, 6) }))
      .filter((d) => d.items.length > 0);
  }

  const deadlines = await scanDeadlines(todayStart);
  return { today, yesterday, weekTop, recentDays, deadlines };
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ── Deadlines (from `due:` / `deadline:` frontmatter) ────────────────────────

let deadlineCache: { root: string; at: number; items: ActivityDeadline[] } | null = null;

function flattenFiles(nodes: VaultNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "dir") out.push(...flattenFiles(n.children));
    else out.push(n.path);
  }
  return out;
}

/** Walk the vault, read each note's `due:` date, and return upcoming (and
 *  recently-overdue) deadlines with days remaining. Cached briefly. */
async function scanDeadlines(todayStart: number): Promise<ActivityDeadline[]> {
  const root = vaultRoot();
  if (deadlineCache && deadlineCache.root === root && Date.now() - deadlineCache.at < DEADLINE_TTL_MS) {
    return deadlineCache.items;
  }
  const items: ActivityDeadline[] = [];
  try {
    const files = flattenFiles(await readTree()).slice(0, 2000);
    for (const path of files) {
      let content: string;
      try {
        content = await readFile(path);
      } catch {
        continue;
      }
      const due = extractDue(content);
      if (!due) continue;
      const dueStart = startOfDay(due.ts);
      const daysLeft = Math.round((dueStart - todayStart) / (24 * 60 * 60 * 1000));
      // Upcoming within ~13 months, plus anything overdue in the last 2 weeks.
      if (daysLeft < -14 || daysLeft > 400) continue;
      const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      items.push({ title: due.title || stem, path, due: due.iso, daysLeft });
    }
  } catch {
    /* tree unreadable — no deadlines this pass */
  }
  items.sort((a, b) => a.daysLeft - b.daysLeft);
  const capped = items.slice(0, 10);
  deadlineCache = { root, at: Date.now(), items: capped };
  return capped;
}

/** Pull a `due`/`deadline` date (and title) out of a note's frontmatter. */
function extractDue(content: string): { ts: number; iso: string; title: string } | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return null;
  const block = fm[1] ?? "";
  const m = /^[ \t]*(?:due|deadline)[ \t]*:[ \t]*["']?(\d{4})-(\d{2})-(\d{2})/im.exec(block);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
  if (Number.isNaN(ts)) return null;
  // Title lives in the same frontmatter block; a plain regex avoids pulling a
  // YAML parser into the main bundle just for one field.
  const tm = /^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(block);
  const title = tm ? (tm[1] ?? "").replace(/^["']|["']$/g, "").trim() : "";
  return { ts, iso: `${y}-${mo}-${d}`, title };
}

// ── Settings surface helpers ─────────────────────────────────────────────────

/** Small stats for the Settings screen. */
export async function activitySummary(): Promise<{ total: number; since: number | null }> {
  const all = await readEvents();
  const root = vaultRoot();
  const mine = all.filter((e) => e.vault === root);
  return { total: mine.length, since: mine.length ? Math.min(...mine.map((e) => e.ts)) : null };
}

/** Show the raw log file in the OS file manager. */
export async function revealActivityFile(): Promise<void> {
  const file = activityFile();
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "", "utf8"); // create it so there's something to reveal
  }
  shell.showItemInFolder(file);
}

/** Erase the entire activity history (all vaults). */
export async function clearActivity(): Promise<void> {
  try {
    await fs.writeFile(activityFile(), "", "utf8");
    deadlineCache = null;
  } catch {
    /* best-effort */
  }
}
