# KestraVault — Overview

An open-source, **AI-first "second brain."** You write and collect notes in a structure that's yours; an AI agent organizes, cross-links, and indexes everything so it can always find what you need. Native desktop + mobile, synced everywhere. Working name: *KestraVault*.

## The idea

People build powerful AI-assisted second brains today by stitching a notes app together with a terminal coding agent, but that setup is:

- hard to set up for non-technical people,
- local-only unless you self-host,
- impossible to run on a phone,
- two separate apps stitched together,
- and usually locked to someone else's organizational system.

KestraVault collapses all of that into **one synced, cross-platform app** — with a structure the user chooses, not one imposed on them.

## The vision

> Write notes and ask questions; an AI agent keeps your vault organized, interlinked, and indexed — *your structure, always findable* — across all your devices, with the AI machinery hidden until you ask for it.

**Magic by default, full control on demand.** Markdown is always the source of truth (never a lossy WYSIWYG lock-in).

### The data model
- **User-chosen folders** — onboarding scaffolds the structure the user picks; the agent grows it with them.
- **The AI guide** (`.kestravault/instructions.md`) — a short, hidden-but-editable file the agent reads before every operation: the vault's purpose, working rules, and a **vault map** (the index of the structure) the agent keeps current so it never has to scan every file.
- **Nothing is ever deleted** by the agent — only moved (e.g. into an archive folder).

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
- **Bring-your-own-model:** Claude subscription, ChatGPT subscription (via the Codex CLI), API key (Anthropic / OpenAI / OpenRouter), or local model (Ollama / LM Studio / any OpenAI-compatible endpoint). Model lists refresh live from each provider, so new models appear without an app update. Keys **encrypted at rest** in the OS keychain, main-process only.
- **Vault onboarding:** a wizard on every new vault (purpose, topics, about-you, style, organizing mode, starting folders) scaffolds the user's structure and writes `.kestravault/instructions.md` — the AI guide, optionally **AI-personalized**: purpose + working rules + a **vault map** (the index) the agent maintains. The guide is injected into every AI chat and grows via a "Learned preferences" section; it's editable in Settings → AI guide.
- **Vault skills:** chat operations that run a real tool-using agent on the vault — *File this note*, *Tidy my vault*, *Reorganize my vault* (also one click in Settings: "Optimize with AI"), plus **user-defined custom skills** — with live progress and changed-file chips (Claude subscription / Anthropic API). The agent can create, edit, and move notes; it can never delete, and app metadata stays read-only.
- **Theming:** dark-first minimal theme with light/dark/system switch.
- **Packaging:** electron-builder for macOS (.dmg/.zip), Windows (NSIS), Linux (AppImage/.deb) — currently unsigned.
- **OSS hygiene:** MIT license, README, SECURITY.md, CONTRIBUTING.md, Electron navigation/link hardening.
- **Core building blocks:** data model, ingest logic, and a 3-way merge engine exist in `packages/core`.

> The desktop AI is a local stand-in for the eventual cloud Managed Agent. The always-on cloud maintenance loop is not wired up yet.

## Planned / future

**Private Beta (next):**
- Cloud backend (Supabase auth + canonical markdown store, one workspace/user).
- The real **cloud agent loop**: capture a note → filed into the structure → index/cross-refs → change feed.
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
- **Tidy** as a cloud operation (a local desktop version ships today as a vault skill).
- Output formats (Marp decks, charts, comparison tables), Dataview-style queries.
- Local-only / self-host runtime, templates gallery, optional web app, scaled vault search (BM25 + vector).

## The "wow"

Write a note → one click files it into your structure with cross-references, a fresh index, and a visible "here's what I changed" feed → ask a question → get a cited answer instantly, because the AI always knows where everything lives. No terminal, on a device you already use.

---
*Full plan lives in [`plan/`](plan/README.md): vision, architecture, data-model, agent-loop, roadmap, open-questions.*
