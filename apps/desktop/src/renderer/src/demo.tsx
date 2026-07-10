// Throwaway screenshot harness: installs a fake `window.api` backed by an
// in-memory vault, seeds a demo AI chat, then boots the real App. Served at
// /demo.html by the dev server only — never part of the packaged app.
import type { VaultNode } from "@renderer/vault/types";

const ROOT = "/Users/ryan/Second Brain";
const PUBLIC_PRIVACY = {
  mode: "public" as const,
  source: "default" as const,
  explicit: false,
  inherited: false,
};

const FILES: Record<string, string> = {
  ".kestravault/config.json": JSON.stringify({
    version: 1,
    onboarding: "done",
    aiPersonalized: true,
    completedAt: "2026-06-20",
    profile: {
      purpose: "mixed",
      topics: "learning science, product design, climbing",
      about: "Product engineer. Reads a lot, forgets a lot — wants the second half fixed.",
      style: "concise",
      language: "",
      ingestMode: "guided",
      categories: ["concepts", "people", "projects"],
    },
  }),
  ".kestravault/instructions.md": "# Instructions\n\nMaintainer schema lives here.\n",
  "index.md": [
    "The map of this vault. The assistant keeps it current.",
    "",
    "## Active",
    "- [[KestraVault Launch]] — ship week. See open tasks.",
    "- [[Spaced Repetition]] — collecting evidence before I rebuild my flashcard habit.",
    "",
    "## Recently grown",
    "- [[Zettelkasten]] ← two new sources this week",
    "- [[Andy Matuschak]] ← notes from the mnemonic medium essay",
    "",
    "## Inbox",
    "- [ ] File [[Huberman — Memory & Learning]] takeaways",
    "- [ ] Merge the two duplicate notes on working memory",
  ].join("\n"),
  "2026-07-04.md": [
    "- Long run before work. Legs fine, HR drifting high — cut coffee?",
    "- Shipped the sync conflict banner. [[KestraVault Launch]]",
    "- Read half of the mnemonic medium essay → notes in [[Andy Matuschak]]",
    "",
    "> Idea: the daily note is the *inbox*, the wiki is the *shelf*. The agent moves things from one to the other so I don't have to.",
  ].join("\n"),
  "sources/Attention Is All You Need.md": [
    "---",
    "type: paper",
    "added: 2026-06-28",
    "---",
    "",
    "Raw highlights from the paper. Filed into [[Transformers]] by the assistant.",
  ].join("\n"),
  "sources/Huberman — Memory & Learning.md": [
    "---",
    "type: podcast",
    "added: 2026-07-03",
    "---",
    "",
    "Transcript dump, 1h52m. Key segments flagged by the assistant:",
    "",
    "- 00:14 — repetition timing (→ [[Spaced Repetition]])",
    "- 00:41 — emotional salience tags memories for consolidation",
    "- 01:20 — sleep's role in moving memory to cortex",
  ].join("\n"),
  "sources/The Extended Mind — Annie Murphy Paul.md": [
    "---",
    "type: book",
    "added: 2026-06-14",
    "---",
    "",
    "Reading notes, chapters 1–4. Thinking happens *with* the environment, not just in the head.",
  ].join("\n"),
  "wiki/concepts/Spaced Repetition.md": [
    "Reviewing material at increasing intervals, timed to just before you'd forget. The single most reliable finding in learning science — and the one I keep failing to apply.",
    "",
    "## Why it works",
    "- **Retrieval beats re-reading.** Pulling a memory out strengthens it far more than looking at it again — testing *is* studying. ([[Huberman — Memory & Learning]], 00:14)",
    "- **Forgetting is a feature.** The struggle to recall is what signals the brain to consolidate. Easy reviews do almost nothing.",
    "- Each successful recall roughly doubles the interval you can wait before the next one.",
    "",
    "## Evidence",
    "- Ebbinghaus (1885) — the original forgetting curve, still replicates.",
    "- Cepeda et al. (2006) — meta-analysis, 839 assessments: spacing wins across every retention interval tested.",
    "- [[Andy Matuschak]]'s mnemonic medium — prompts embedded in the reading itself, so review needs no separate habit.",
    "",
    "## Where I want to apply it",
    "- [ ] Rebuild the flashcard deck around *questions I actually failed*, not highlights",
    "- [ ] Weekly review of [[Zettelkasten]] permanent notes counts as a spaced pass",
    "",
    "## Related",
    "[[Working Memory]] · [[Zettelkasten]] · [[The Extended Mind — Annie Murphy Paul]]",
  ].join("\n"),
  "wiki/concepts/Zettelkasten.md": [
    "Luhmann's slip-box: atomic notes, densely linked, written in your own words.",
    "",
    "- A note is finished when it can stand alone.",
    "- Links matter more than categories — see [[Spaced Repetition]] for why re-encountering ideas works.",
    "- The KestraVault agent automates the *filing* half of this; writing stays human. [[KestraVault Launch]]",
  ].join("\n"),
  "wiki/concepts/Working Memory.md": [
    "~4 chunks, not 7. Offloading to paper/notes isn't cheating — it's the whole point of [[The Extended Mind — Annie Murphy Paul]].",
  ].join("\n"),
  "wiki/concepts/Transformers.md": [
    "Attention as a lookup over the whole context window. Source: [[Attention Is All You Need]].",
  ].join("\n"),
  "wiki/people/Andy Matuschak.md": [
    "Researcher on tools for thought. Coined the **mnemonic medium** — spaced-repetition prompts woven into essays.",
    "",
    '- "Evergreen notes" ≈ [[Zettelkasten]] permanent notes, with better branding.',
    "- Argues most note-taking fails because notes are written but never *revisited* → exactly the gap [[Spaced Repetition]] closes.",
  ].join("\n"),
  "wiki/projects/KestraVault Launch.md": [
    "Ship the free desktop build + landing page.",
    "",
    "- [x] Sync conflict banner",
    "- [x] Release workflow (draft releases)",
    "- [ ] Landing page copy pass",
    "- [ ] Pre-flip secret sweep",
  ].join("\n"),
  "notes/Ideas.md": [
    '- A "review queue" ribbon icon: the agent surfaces 3 wiki pages a day you haven\'t touched in a month.',
    "- Daily note → weekly rollup, written by the agent, linked from [[index]].",
  ].join("\n"),
};

// ── Build a VaultNode tree from the flat path map ────────────────────────────
function buildTree(): VaultNode[] {
  const rootNodes: VaultNode[] = [];
  const dirs = new Map<string, VaultNode[]>();
  const childrenOf = (dirPath: string): VaultNode[] => {
    if (dirPath === "") return rootNodes;
    let kids = dirs.get(dirPath);
    if (kids) return kids;
    kids = [];
    dirs.set(dirPath, kids);
    const slash = dirPath.lastIndexOf("/");
    const parent = childrenOf(slash === -1 ? "" : dirPath.slice(0, slash));
    parent.push({
      kind: "dir",
      name: slash === -1 ? dirPath : dirPath.slice(slash + 1),
      path: `${ROOT}/${dirPath}`,
      children: kids,
      privacy: PUBLIC_PRIVACY,
    });
    return kids;
  };
  for (const rel of Object.keys(FILES)) {
    if (rel.startsWith(".kestravault/")) continue; // hidden internals
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash);
    childrenOf(dir).push({
      kind: "file",
      name: slash === -1 ? rel : rel.slice(slash + 1),
      path: `${ROOT}/${rel}`,
      privacy: PUBLIC_PRIVACY,
    });
  }
  const sort = (nodes: VaultNode[]): void => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    for (const n of nodes) if (n.kind === "dir") sort(n.children);
  };
  sort(rootNodes);
  return rootNodes;
}

const rel = (path: string): string =>
  path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;

// ── The window.api mock ──────────────────────────────────────────────────────
const noop = (): void => undefined;
const unsub = (): (() => void) => noop;

window.api = {
  platform: "darwin",
  versions: { electron: "33.4.11", chrome: "130", node: "20" },
  app: { version: async () => "0.1.0" },
  vault: {
    root: async () => ROOT,
    tree: async () => buildTree(),
    privacyRules: async () => [],
    setPrivacy: async () => undefined,
    clearPrivacy: async () => undefined,
    read: async (path: string) => {
      const content = FILES[rel(path)];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    write: async (path: string, content: string) => {
      FILES[rel(path)] = content;
    },
    readBinary: async (path: string) => {
      throw new Error(`ENOENT: ${path}`); // demo vault holds no binary assets
    },
    writeBinary: async (path: string) => path,
    create: async (path: string, content = "") => {
      FILES[rel(path)] = content;
      return path;
    },
    createDir: async (path: string) => path,
    rename: async (_path: string, next: string) => next,
    remove: async (path: string) => {
      delete FILES[rel(path)];
    },
    reveal: async () => undefined,
    onChanged: unsub,
    list: async () => [{ path: ROOT, name: "Second Brain", current: true }],
    switch: async (path: string) => path,
    add: async () => null,
    createVault: async () => null,
    removeVault: async () => [{ path: ROOT, name: "Second Brain", current: true }],
  },
  ai: {
    send: async () => undefined,
    cancel: async () => undefined,
    status: async () => ({ connected: true }),
    resetStatus: async () => undefined,
    onEvent: unsub,
    agent: async () => undefined,
    onAgentEvent: unsub,
  },
  secret: {
    set: async () => undefined,
    list: async () => [],
    available: async () => true,
  },
  sync: {
    getConfig: async () => ({
      mode: "hosted" as const,
      hostedAvailable: true,
      selfHostUrl: "",
      hasSelfHostKey: false,
      configured: true,
    }),
    setConfig: async () => ({
      mode: "hosted" as const,
      hostedAvailable: true,
      selfHostUrl: "",
      hasSelfHostKey: false,
      configured: true,
    }),
    signUp: async () => "",
    signIn: async () => ({ userId: "u1", email: "ryan@example.com", hasActivePlan: true }),
    signOut: async () => undefined,
    account: async () => ({ userId: "u1", email: "ryan@example.com", hasActivePlan: true }),
    redeemCode: async () => ({ userId: "u1", email: "ryan@example.com", hasActivePlan: true }),
    status: async () => ({
      configured: true,
      signedIn: true,
      email: "ryan@example.com",
      workspaceId: "ws1",
      workspaceName: "Second Brain",
      syncing: false,
      lastSyncAt: Date.now() - 120_000,
      lastError: null,
      lastSummary: "Up to date",
      conflicts: [],
    }),
    now: async () => ({
      configured: true,
      signedIn: true,
      email: "ryan@example.com",
      workspaceId: "ws1",
      workspaceName: "Second Brain",
      syncing: false,
      lastSyncAt: Date.now(),
      lastError: null,
      lastSummary: "Up to date",
      conflicts: [],
    }),
    workspaces: async () => [
      { id: "ws1", name: "Second Brain", role: "owner" as const, createdAt: "2026-06-01" },
    ],
    createWorkspace: async (name: string) => ({
      id: "ws2",
      name,
      role: "owner" as const,
      createdAt: "2026-07-04",
    }),
    link: async () => undefined,
    unlink: async () => undefined,
    onStatus: unsub,
    test: async () => ({ ok: true, services: [] }),
  },
  activity: {
    record: async () => undefined,
    context: async () => ({
      today: [
        { title: "2026-07-04", verb: "edited" as const, path: `${ROOT}/2026-07-04.md` },
        {
          title: "Spaced Repetition",
          verb: "edited" as const,
          path: `${ROOT}/wiki/concepts/Spaced Repetition.md`,
        },
      ],
      yesterday: [
        {
          title: "Huberman — Memory & Learning",
          verb: "created" as const,
          path: `${ROOT}/sources/Huberman — Memory & Learning.md`,
        },
      ],
      weekTop: [
        { title: "Spaced Repetition", edits: 9 },
        { title: "KestraVault Launch", edits: 6 },
      ],
      recentDays: [],
      deadlines: [],
    }),
    summary: async () => ({ total: 148, since: Date.now() - 12 * 86_400_000 }),
    reveal: async () => undefined,
    clear: async () => undefined,
  },
  updates: {
    setEnabled: async () => undefined,
    onAvailable: unsub,
  },
  collab: {
    members: async () => [
      {
        userId: "u1",
        role: "owner" as const,
        createdAt: "2026-06-01",
        isSelf: true,
        email: "ryan@example.com",
      },
    ],
    invite: async () => "https://kestravault.app/join/demo",
    join: async () => [],
    removeMember: async () => undefined,
    feed: async () => [],
    changeSets: async () => [],
    revertChangeSet: async (changeSetId: string) => ({
      status: "already_reverted" as const,
      changeSetId,
      revertChangeSetId: null,
      fileCount: 0,
    }),
    setActiveNote: () => undefined,
    onPresence: unsub,
  },
};

// ── Seed a believable AI conversation (chats live in localStorage) ───────────
const now = Date.now();
localStorage.setItem(
  "kestravault.ai.chats.v1",
  JSON.stringify({
    activeId: "chat-demo",
    chats: [
      {
        id: "chat-demo",
        title: "File the Huberman episode",
        model: "sonnet",
        createdAt: now - 3_600_000,
        updatedAt: now - 60_000,
        turns: [
          {
            id: "t1",
            role: "user",
            content: "I dropped the Huberman memory episode into sources. Anything worth filing?",
          },
          {
            id: "t2",
            role: "assistant",
            content: [
              "Read it — three takeaways are worth keeping:",
              "",
              '1. **Retrieval beats re-reading.** Testing yourself is what consolidates memory, not another pass over the notes. I added this to *Spaced Repetition* under "Why it works", with the timestamp.',
              "2. **Emotional salience tags memories** for consolidation — new, didn't fit an existing page, so I noted it in the source for now.",
              "3. **Sleep does the filing.** Links back to what you highlighted in *The Extended Mind* ch. 3.",
              "",
              'Your *Spaced Repetition* page also had a claim with no source — the "doubling interval" one. The episode backs it, so I cited it.',
            ].join("\n"),
            sources: [
              {
                name: "Huberman — Memory & Learning",
                path: `${ROOT}/sources/Huberman — Memory & Learning.md`,
              },
              { name: "Spaced Repetition", path: `${ROOT}/wiki/concepts/Spaced Repetition.md` },
              {
                name: "The Extended Mind — Annie Murphy Paul",
                path: `${ROOT}/sources/The Extended Mind — Annie Murphy Paul.md`,
              },
            ],
            changed: [
              { path: `${ROOT}/wiki/concepts/Spaced Repetition.md`, op: "update" },
              { path: `${ROOT}/sources/Huberman — Memory & Learning.md`, op: "update" },
            ],
          },
          {
            id: "t3",
            role: "user",
            content: "Perfect. What's still in my inbox?",
          },
          {
            id: "t4",
            role: "assistant",
            content:
              "Two things: merging the duplicate *Working Memory* notes, and a copy pass on the launch page — both tracked on *Home*. Want me to do the merge? It's mechanical.",
            sources: [{ name: "index", path: `${ROOT}/index.md` }],
          },
        ],
      },
    ],
  }),
);

// Boot the real app with the mock in place, then optionally drive it into a
// named state for headless screenshots: /demo.html?shot=editor|hero|graph
async function drive(): Promise<void> {
  const shot = new URLSearchParams(location.search).get("shot");
  if (!shot) return;
  const style = document.createElement("style");
  style.textContent =
    "* { caret-color: transparent !important; } .cm-cursor { display: none !important; }";
  document.head.appendChild(style);
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const click = (el: Element | undefined): void => {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    (el as HTMLElement).click();
  };
  await wait(900);
  // Open the showcase note in all states.
  click(
    [...document.querySelectorAll(".tree-label")].find(
      (e) => e.textContent?.trim() === "Spaced Repetition",
    ),
  );
  await wait(700);
  if (shot === "hero" || shot === "ai") {
    click([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Ask AI")));
    await wait(900);
  }
  if (shot === "graph") {
    const btns = [...document.querySelectorAll<HTMLElement>("button,[role='button']")];
    click(
      btns.find((b) =>
        (b.getAttribute("aria-label") ?? b.title ?? "").toLowerCase().includes("graph"),
      ),
    );
    await wait(2000);
  }
  document.title = `ready:${shot}`;
}

void import("./main").then(drive);
