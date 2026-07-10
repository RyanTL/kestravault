import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutable knobs shared with the hoisted mocks. Tests point the log at a throwaway
// userData dir and stand in a fake vault (root + file tree + file contents) so the
// deadline scan has something to read.
const env = vi.hoisted(() => ({
  userDataDir: "",
  root: "/vault",
  tree: [] as Array<{ kind: "file" | "dir"; name: string; path: string; children?: unknown[] }>,
  files: {} as Record<string, string>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return env.userDataDir;
    },
  },
  shell: { showItemInFolder: () => {} },
}));

vi.mock("./vault.js", () => ({
  vaultRoot: () => env.root,
  readTree: async () => env.tree,
  readFile: async (rel: string) => {
    const c = env.files[rel];
    if (c === undefined) throw new Error(`no file ${rel}`);
    return c;
  },
}));

import { recordEvent, activityContext, activitySummary, clearActivity } from "./activity.js";

const DAY = 24 * 60 * 60 * 1000;
const logPath = (): string => join(env.userDataDir, "activity.jsonl");

/** Local YYYY-MM-DD for a timestamp, matching how notes write `due:`. */
function ymd(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function writeLog(events: Array<Record<string, unknown>>): void {
  writeFileSync(logPath(), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

beforeEach(async () => {
  env.userDataDir = mkdtempSync(join(tmpdir(), "kestravault-activity-"));
  env.root = "/vault";
  env.tree = [];
  env.files = {};
  await clearActivity(); // resets the deadline cache + empties the file
});

afterEach(() => {
  rmSync(env.userDataDir, { recursive: true, force: true });
});

describe("recordEvent + activitySummary", () => {
  it("appends events for the current vault and counts them", async () => {
    await recordEvent({ type: "open", path: "A.md", title: "A" });
    await recordEvent({ type: "edit", path: "A.md", title: "A" });
    const s = await activitySummary();
    expect(s.total).toBe(2);
    expect(s.since).not.toBeNull();
  });

  it("truncates a long `ask` question to keep the log small", async () => {
    await recordEvent({ type: "ask", path: "", note: "x".repeat(500) });
    const s = await activitySummary();
    expect(s.total).toBe(1);
  });
});

describe("activityContext aggregation", () => {
  it("buckets today / yesterday, rolls up the week, and reads deadlines", async () => {
    const now = Date.now();
    writeLog([
      { ts: now, vault: env.root, type: "edit", path: "Alpha.md", title: "Alpha" },
      { ts: now - 60_000, vault: env.root, type: "edit", path: "Alpha.md", title: "Alpha" },
      { ts: now, vault: env.root, type: "open", path: "Beta.md", title: "Beta" },
      { ts: now - DAY, vault: env.root, type: "create", path: "Gamma.md", title: "Gamma" },
      { ts: now - 5 * DAY, vault: env.root, type: "edit", path: "Delta.md", title: "Delta" },
      // A different vault's events must never leak into this vault's digest.
      { ts: now, vault: "/other", type: "edit", path: "Nope.md", title: "Nope" },
    ]);
    env.tree = [{ kind: "file", name: "Proj.md", path: "Proj.md" }];
    env.files["Proj.md"] = ["---", "title: Launch", `due: ${ymd(now + 5 * DAY)}`, "---", ""].join(
      "\n",
    );

    const ctx = await activityContext({ deep: true });

    const todayTitles = ctx.today.map((i) => i.title);
    expect(todayTitles).toContain("Alpha");
    expect(todayTitles).toContain("Beta");
    expect(todayTitles).not.toContain("Nope"); // other vault filtered out
    expect(ctx.today.find((i) => i.title === "Alpha")?.verb).toBe("edited");

    expect(ctx.yesterday.map((i) => i.title)).toEqual(["Gamma"]);

    // Two edits to Alpha today → shows up in the weekly rollup with a count.
    expect(ctx.weekTop.find((w) => w.title === "Alpha")?.edits).toBe(2);

    // Five days ago falls into the deep breakdown, not today/yesterday.
    const deepTitles = ctx.recentDays.flatMap((d) => d.items.map((i) => i.title));
    expect(deepTitles).toContain("Delta");

    const proj = ctx.deadlines.find((d) => d.title === "Launch");
    expect(proj?.daysLeft).toBe(5);
  });

  it("returns empty buckets when nothing was recorded", async () => {
    const ctx = await activityContext();
    expect(ctx.today).toEqual([]);
    expect(ctx.yesterday).toEqual([]);
    expect(ctx.deadlines).toEqual([]);
  });
});
