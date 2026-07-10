# Data Model

_How a workspace ("a brain") is structured, stored, synced, and versioned. Implements vision decisions #3–5, #10, #20 and the locked sync engine._

## Two representations of the same data
The same markdown exists in two forms; sync keeps them consistent.

```
  SERVER (canonical)                         CLIENTS
  ┌────────────────────────┐                ┌─────────────────────────────┐
  │ Supabase Postgres       │  ← sync →      │ Desktop: real on-disk folder │  (Obsidian/git-clean)
  │  files (content+meta)   │                │   + local sync state (sqlite)│
  │  file_versions (history)│                ├─────────────────────────────┤
  │  change_sets            │                │ Mobile: cached view + queue  │  (no folder)
  │ Supabase Storage        │                └─────────────────────────────┘
  │  assets (images/blobs)  │
  └────────────────────────┘
```

- **Canonical = Postgres** (markdown content + metadata + full version history + agent change-sets) and **Storage** (binary assets). This is what the cloud agent reads/writes and what every client syncs from. Postgres (not object storage) for the markdown because files are small, frequently diffed/versioned, and need transactional version bumps + Realtime push.
- **Desktop = a real folder of clean markdown** the user can git or open in Obsidian, plus a hidden local sync DB. The folder contains *only* user-facing markdown + `.kestravault/instructions.md` — never the version/manifest cruft (that lives server-side), so the folder stays Obsidian-clean.
- **Mobile = a thin synced view** with an offline cache + an outbound edit queue.

## Per-workspace layout (the on-disk / logical tree)
```
<workspace>/
  sources/                      # immutable raw inputs — human drops; agent reads, NEVER writes
    s-2026-06-27-rust-intro.md
    assets/                     # images/attachments referenced by sources (binary → Storage)
  wiki/                         # agent-owned, interlinked knowledge (structure scaffolded at onboarding)
    entities/                   # people, companies, products…
    concepts/
    topics/
    sources/                    # per-source summary pages (the agent's digest of each raw source)
  notes/                        # human-owned; agent reads, edits ONLY if explicitly asked
  index.md                      # content catalog (agent-maintained) — app renders as the "Map"
  log.md                        # append-only chronological record (agent-maintained) — backs the Activity feed
  .kestravault/                     # app metadata (hidden from the main note UI)
    instructions.md             # the CLAUDE.md-equivalent / schema — edited via "Brain settings"
    config.json                 # per-workspace config (model routing, ingest mode, scaffold structure)
    privacy.local.json          # LOCAL-only path privacy rules + tombstones; never synced as markdown
    sync.db                     # LOCAL-only client sync state (gitignored; not synced)
```
Each **workspace is fully isolated** — its own tree, its own agent instructions; the agent never reads across workspaces (vision #5).

## Path privacy modes

Notes and folders have an effective privacy mode, resolved from exact path rules,
folder inheritance, and the legacy per-note `private: true` frontmatter flag:

| Mode | Sync | Remote/cloud AI |
|---|---|---|
| `public` | synced normally | may read body |
| `cloud-ai-private` | synced to the workspace and visible to shared-workspace members | may see only title/path plus description/tags metadata; body/snippets are hidden |
| `local-only` | never uploaded; existing cloud copies are soft-deleted on the next sync | invisible |

Folder rules are inherited by descendants unless a child has an explicit rule.
`local-only` lives only in `.kestravault/privacy.local.json`; it is not stored in
Postgres. Cloud-synced privacy metadata lives in `privacy_rules` and supports
only `public` and `cloud-ai-private`.

Important caveat: `cloud-ai-private` is an app/orchestrator AI access-control
guarantee. The markdown still exists in the cloud database for sync and shared
workspaces; it is not end-to-end encryption from the database operator.

## The three zones & enforced permissions
| Zone | Human | Agent | Enforcement |
|---|---|---|---|
| `sources/` | create/delete (immutable content) | **read-only** | Mounted read-only into the agent container; agent has no write path here. |
| `wiki/` | read/write (edits are authoritative) | **read/write** | Agent's primary work area. Human edits win on conflict (see Sync). |
| `notes/` | read/write | **read-only by default** | Agent only writes here when the user explicitly asks ("organize this", "make this a wiki page"). |
| `.kestravault/instructions.md` | edit via Brain settings (AI-assisted) | **read-only at runtime** | The agent reads its schema each run but cannot silently rewrite its own rules — schema changes are a human action. It may *propose* changes for approval. |
| `index.md`, `log.md` | rarely edit directly | read/write | Agent maintains; app surfaces as Map + Activity views. |

## File naming & IDs
- **Stable ID** in frontmatter (`id:` = a ULID), so links/history survive renames.
- **Human-readable filenames** (slugs). Sources prefixed `s-<date>-<slug>.md` (Karpathy convention — keeps the log greppable).
- **Cross-references = `[[wikilinks]]`** (Obsidian-compatible). **Link text is always the human-readable title/slug** (optionally `[[title|alias]]`) — never a raw ULID. The app resolves title → `id` and rewrites links on rename; the `id` stays the durable anchor in frontmatter while the link text stays readable for humans and Obsidian.
- Links live **inline in prose** (where the context is); **backlinks are derived** (graph/index) and never stored in frontmatter — no duplication, no churn.

## Frontmatter conventions (YAML, Dataview-friendly)
```yaml
# sources/s-2026-06-27-rust-intro.md
id: 01J8Z…              # ULID
title: "Intro to Rust ownership"
summary: "Beginner overview of Rust ownership, borrowing, and lifetimes."  # one line; filled on ingest, powers cheap retrieval
type: source
zone: sources
added: 2026-06-27
origin: paste            # paste | upload | url  (v1 = paste only)
url: null
tags: [rust, programming]
status: ingested         # pending | ingested | failed
```
```yaml
# wiki/concepts/ownership.md
id: 01J8…
title: "Ownership (Rust)"
aliases: [ownership, borrow checker, move semantics]   # natural names → better linking + grep hit-rate (Obsidian-native)
summary: "Rust's compile-time memory model: each value has one owner; moves/borrows enforce safety."  # one line; drives index-first retrieval
type: concept            # entity | concept | topic | overview | comparison | source-summary
zone: wiki
created: 2026-06-27
updated: 2026-06-27
sources: [01J8Z…]        # source ids this page draws on (provenance)
tags: [rust]
status: active
```
```yaml
# notes/2026-06-27-standup.md
id: 01J8…
title: "Standup notes"
type: note
zone: notes
created: 2026-06-27
updated: 2026-06-27
ai_managed: false        # human-owned; agent reads, won't edit unless asked
tags: []
```

The two fields that do the heavy lifting for AI retrieval are **`summary`** (a one-liner — lets the agent judge relevance from frontmatter alone, without opening the body) and **`aliases`** (raises grep/keyword hit-rate and lets the agent link by natural names). Both are standard on `wiki/` pages, optional on `notes/`. Keep **`tags` to a controlled vocabulary** (declared in `.kestravault/instructions.md`) so `rust` / `Rust` / `rust-lang` don't fragment retrieval.

## Page anatomy (wiki pages)
A fixed, predictable shape keeps pages cheap to skim, cheap to diff, and easy to merge — edits stay localized to one section (helps the 3-way merge, vision #10). **One concept/entity per page; keep them small and atomic.**

```text
---
id · title · aliases · summary · type · tags · sources · created · updated · status
---
# Ownership (Rust)
> one-line summary (mirrors `summary:`)

## Key facts   — atomic bullets the agent maintains; the cheapest thing to read + update
## Details     — prose, with inline [[cross-references]]
## Sources     — derived from `sources:` (provenance / citations)
```

Predictable headings also let the agent target and edit a single section (`[[page#Key facts]]`) instead of rewriting a whole file.

## index.md & log.md
- **`index.md`** — content-oriented catalog: every wiki page with a link, one-line summary, and metadata, grouped by category. **Each entry is one line, drawn from the page's `title` + `summary` + `tags`** — so it stays consistent and can be regenerated from frontmatter (Obsidian Bases-style) instead of hand-maintained. The agent updates it on every ingest; the **query loop reads it first** to find relevant pages (cheap retrieval before embeddings — see [agent-loop.md](agent-loop.md), O9).
- **`log.md`** — chronological, append-only, one entry per operation with a consistent prefix so it stays greppable, e.g. `## [2026-06-27] ingest | Intro to Rust ownership`. Backs the **Activity feed**.

## Server canonical schema (Supabase Postgres — sketch)
```
workspaces(id, owner_id, name, created_at, config jsonb)
files(id, workspace_id, path, zone, type, title, content text, sha256,
      version int, updated_by enum(human,agent), updated_at, deleted bool)
file_versions(id, file_id, version, content, sha256, updated_by, change_set_id, created_at)
change_sets(id, workspace_id, kind enum(ingest,query_fileback,lint,manual),
            summary, source_event jsonb, created_at, reverted bool)
file_changes(id, change_set_id, file_id, op enum(create,update,delete),
             before_version, after_version, diff text)
assets(id, workspace_id, storage_path, mime, sha256, created_at)   -- binary → Storage
privacy_rules(workspace_id, path, target enum(file,folder),
              mode enum(public,cloud-ai-private), updated_by, updated_at, deleted)
```
Realtime broadcasts `files`/`change_sets` inserts so clients update live (desktop writes to the folder mirror; mobile refreshes the view).

## Sync & versioning (file-level git-style 3-way merge)
- Each client tracks, per file, the **`base_version`** = the last version it synced (the common ancestor).
- Local-only privacy rules filter paths out of the local sync view. If a filtered
  path already exists in the canonical store, sync treats it as a local delete
  and soft-deletes the cloud copy; remote-only local-only paths are not pulled
  back.
- **On sync, per file:**
  - only local changed since base → push (fast-forward, bump version).
  - only canonical changed → pull.
  - **both changed → 3-way text merge** (diff3) of `base / local / canonical`. Clean → new merged version. Conflicting hunk → write a `*.conflict.md` copy and flag in the UI (rare).
- **Human ↔ AI rule (vision #10):** the agent writes new canonical versions as part of a **change-set**; it never silently overwrites a file the human has *uncommitted local edits* on. If a human edit and an agent edit truly clash on the same hunk, **the human hunk wins**, and the agent's intended change is preserved in the change-set so the user can re-apply it from the change feed if they want.

## Change-sets, history & undo
- Every agent run = one **atomic change-set** (`kind`, `summary`, the list of `file_changes` with diffs). Applied to canonical only on clean completion; partials are discarded.
- The change-set backs the **change feed** ("Ingested 'X' — touched N pages", expandable diffs) and **one-tap undo** (revert = apply the inverse and bump versions; `reverted=true`).
- Human edits are versioned too (`updated_by=human`) but not grouped as agent change-sets.

## Assets
Binary attachments (images, PDFs as source files) live in **Supabase Storage**; markdown references them by a stable URL/key. v1 (paste-only capture) needs little of this; it matters when upload/URL capture lands (Post-MVP).
