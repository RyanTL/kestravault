# KestraVault — Overview gy

An open-source, **AI-first "second brain."** You drop in raw sources and ask questions; a cloud agent compiles and continuously maintains a living, interlinked **markdown wiki** from them. Native desktop + mobile, synced everywhere. Working name: *KestraVault*.

## The idea

Productize Andrej Karpathy's ["LLM Wiki" pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and strip out the friction. People build powerful second brains today with **Obsidian + Claude Code**, but that setup is:

- hard to set up for non-technical people,
- local-only unless you self-host,
- impossible to run on a phone (no Claude Code on mobile),
- two separate apps stitched together.

KestraVault collapses all of that into **one synced, cross-platform app**.

## The vision

> Drop in sources and ask questions; an AI agent compiles and continuously maintains an interlinked wiki — *integrate once, keep fresh* — across all your devices, with plain manual notes whenever you want, and the AI machinery hidden until you ask for it.

**Magic by default, full control on demand.** Markdown is always the source of truth (never a lossy WYSIWYG lock-in).

### The three-zone data model
- `sources/` — your raw inputs, **immutable**.
- `wiki/` — the interlinked knowledge base, **agent-owned**.
- `notes/` — plain manual notes, **human-owned**.

Plus an `index`, a change `log`, and hidden plain-language agent instructions.

## Stack

TypeScript monorepo (pnpm + turborepo).
- `packages/core` — platform-agnostic logic (data models, sync engine, Supabase client, agent client, 3-way merge). No DOM/Electron/RN imports.
- `apps/desktop` — React + CodeMirror 6, wrapped in **Electron**.
- `apps/mobile` — React Native (**Expo**) + CodeMirror 6 in a WebView.
- Backend: **Supabase** (Postgres/auth/storage/realtime). Cloud agent: **Anthropic Managed Agents**. Sync: file-level git-style **3-way merge**.

## Implemented today (desktop, local-only)

- **Markdown editor** (CodeMirror 6) over a real on-disk vault: file-tree CRUD with drag-to-move, Obsidian-style Live Preview, wikilinks.
- **Notion-style header** (tabs → breadcrumb path → editable inline title), clean new notes (no boilerplate, properties hidden until added), tabs + split panes.
- **Navigation:** quick switcher (⌘O), command palette (⌘P), full-text search (⌘⇧F), right-sidebar outline + backlinks, graph view, bookmarks.
- **AI assistant (Notion-style):** right-side **Ask AI** chat (⌘J) with streaming, page-scoped vs whole-vault context, source citations, model picker, and page actions (summarize / improve / action items / translate). "Search or ask AI" combines AI + full-text hits. Runs on the user's **Claude subscription** via the Claude Agent SDK — no API key (one-time `claude /login`).
- **Bring-your-own-model:** Claude subscription, API key (Anthropic / OpenAI / OpenRouter), or local model (Ollama / LM Studio / any OpenAI-compatible endpoint). Keys **encrypted at rest** in the OS keychain, main-process only.
- **Brain onboarding:** a wizard on every new vault (purpose, topics, about-you, style, ingest mode, wiki sections) scaffolds the three zones and writes `.kestravault/instructions.md` — the vault's schema, optionally **AI-personalized** — plus `AGENTS.md`/`CLAUDE.md` stubs so Claude Code and Codex/ChatGPT follow the same rules inside the vault folder. The schema is injected into every AI chat, and grows via a "Learned preferences" section.
- **Vault skills (Ingest / Lint):** chat buttons that run a real tool-using agent on the vault — sandboxed to `wiki/**`, `index.md`, `log.md` — with live progress and changed-file chips (Claude subscription / Anthropic API).
- **Theming:** dark-first minimal theme with light/dark/system switch.
- **Packaging:** electron-builder for macOS (.dmg/.zip), Windows (NSIS), Linux (AppImage/.deb) — currently unsigned.
- **OSS hygiene:** AGPLv3 license, README, SECURITY.md, CONTRIBUTING.md, Electron navigation/link hardening.
- **Core building blocks:** data model, ingest logic, and a 3-way merge engine exist in `packages/core`.

> The desktop AI is a local stand-in for the eventual cloud Managed Agent. The core ingest/wiki-maintenance loop is not wired up yet.

## Planned / future

**Private Beta (next):**
- Cloud backend (Supabase auth + canonical markdown store, one workspace/user).
- The real **cloud agent loop**: ingest a source → wiki page → index/cross-refs → change log.
- **Change feed + undo** for agent edits; **query with citations**.
- Hidden **Brain settings** (a UI for editing the plain-language instructions), model routing (Haiku/Sonnet/Opus), sync to a local folder.

**MVP (public):**
- **Native mobile** (Expo) to parity; full offline (desktop) + queued offline (mobile).
- **Multiple workspaces** per user (personal vs business).
- **Billing:** free metered tier + ~$15 paid quota (Stripe), BYO-key escape, usage dashboard.
- Merge-conflict handling, error/retry polish, open-core repo split.

**Post-MVP backlog:**
- **Teams / collaboration** (shared workspaces, permissions, presence, ~$50 plan).
- More capture: file upload (PDF/docx/md/txt), URL fetch & convert, mobile share-sheet, web clipper, email-in, voice → transcribe.
- **Import** from Notion / Obsidian.
- **Lint** as a cloud operation (a local desktop version ships today as a vault skill).
- Output formats (Marp decks, charts, comparison tables), Dataview-style queries.
- Local-only / self-host runtime, templates gallery, optional web app, scaled wiki search (BM25 + vector).

## The "wow"

Drop a source → within moments the wiki has a new page, updated cross-references, and a visible "here's what I changed" feed → ask a question → get a cited answer you can file back. No terminal, on a device you already use.

---
*Full plan lives in [`plan/`](plan/README.md): vision, architecture, data-model, agent-loop, roadmap, open-questions.*
