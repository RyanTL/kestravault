# Architecture & Tech Stack

## High-level shape
```
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Desktop app │   │ Mobile app  │   │  (Web app)  │   ← shared TS core; UI per platform
   │ (Electron)  │   │ (RN/Expo)   │   │  later/opt. │
   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
          │  sync (file-level, git-style 3-way merge)
   ┌──────┴───────────────────────────────────┴──────┐
   │  Cloud backend (Supabase: Postgres + auth +      │
   │  object storage + realtime) + Stripe (billing)   │
   │  • CANONICAL markdown store (the source of truth) │
   │  • quota/credits metering                         │
   └──────────────────────┬───────────────────────────┘
                          │ mount wiki per session, stream events
                ┌─────────┴──────────┐
                │  Cloud agent        │  ← Anthropic Managed Agents
                │  (per-session       │     (hosted container: bash/read/
                │   container w/ the  │      write/edit/grep over the wiki)
                │   Claude-Code env)  │
                └────────────────────┘
```
Desktop additionally **mirrors the canonical markdown to a real on-disk folder** (git- and Obsidian-compatible). Mobile is a synced view.

## Data model & file flow
- **Source of truth:** markdown files, **canonical in the cloud** (so the agent can read/rewrite them and mobile can sync). [vision #3, #6]
- **Desktop:** continuously mirrors the canonical store to a real local folder the user can git, open in Obsidian, or edit with any tool. [Reconciles "files on disk" with "cloud agent."]
- **Mobile:** thin synced client (cached + queued offline; no real folder).
- **Per workspace:** its own `sources/`, `wiki/`, `notes/`, plus an `index`, `log`, and hidden agent-instructions doc. Workspaces never cross. [vision #4, #5]

## Sync & conflicts
- **Engine:** file-level sync with **automatic 3-way merge (git-style)**. Version each markdown file; auto-merge on sync; surface a conflict only on a rare true clash. No full CRDT (we deliberately chose *not* to do live human↔AI co-editing). [vision #10]
- **Offline:** full offline editing on desktop; cached + queued on mobile; the agent catches up on reconnect.
- **Human↔AI:** the agent writes its edits as a reviewable diff/layer and never overwrites a note the human is actively editing; human edits are authoritative.

## The agent
- **Cloud runtime:** **Anthropic Managed Agents** — a hosted per-session container with `bash/read/write/edit/grep` tools, i.e. the Claude Code environment as a service, operating directly on the mounted wiki. Offloads the entire sandbox + orchestration problem. _(Beta — track maturity.)_ [vision #6]
- **Local / self-host / BYO-model runtime:** a **portable agent loop** (Claude API tool-use loop, or any provider — OpenAI, local models) that users run themselves. Honors "use your own models." Same logical operations, different execution host.
- **Operations:** **Ingest** (read source → discuss/summarize → write wiki page → update index + relevant entity/concept pages → append log), **Query** (search index → read pages → synthesize with citations; good answers can be filed back as pages), and later **Lint** (health-check: contradictions, stale claims, orphans, missing cross-refs).
- **Model routing:** Haiku for bookkeeping; Sonnet/Opus for synthesis & hard queries. [vision #8]
- **Cost controls:** async/Batch ingestion (50% off), aggressive prompt caching (stable system prompt + wiki prefix), per-user quota metering. [vision #9, economics]

## Stack
| Layer | Choice | Status |
|---|---|---|
| Language / UI | **TypeScript + React** across all clients — incl. AI orchestration (no Python service for now) | locked 2026-06-27 |
| Mobile | **React Native (Expo)** — CodeMirror editor runs in a WebView, bridged | locked 2026-06-27 |
| Desktop shell | **Electron** (wraps the web app; Node FS for the folder-mirror) | locked 2026-06-27 |
| Editor | **CodeMirror 6** (markdown source + live preview, Obsidian-style — lossless round-trip) | locked [vision] |
| Sync | **File-level + git-style 3-way merge** | locked |
| Backend | **Supabase** (Postgres, auth, object storage, realtime) — **managed now, AWS-portable later** | locked 2026-06-27 |
| Billing | **Stripe** (subscriptions + metered quota) | asserted |
| Cloud agent | **Anthropic Managed Agents** | locked |
| Local agent | Portable, provider-agnostic loop | locked (later phase) |

### Why these fit
- **CodeMirror 6** keeps markdown lossless — re-introducing a WYSIWYG block editor (TipTap/Lexical) would bring back the lossy round-trip risk we deliberately rejected.
- **Git-style sync** is lighter than CRDT and matches the "AI proposes diffs" model; CRDT can come later only if live editing is added.
- **Managed Agents** is purpose-built for an agent operating on a folder of files; the local loop preserves the open-source / BYO-model promise.
- **Supabase** is fast to stand up, open-source, and self-hostable — consistent with the open-core story.

## Code structure (monorepo)
We chose **Electron desktop + React Native mobile** — Notion's exact, proven combination (confirmed by the [Pragmatic Engineer teardown](https://newsletter.pragmaticengineer.com/p/notion-going-native-on-ios-and-android) and [3perf's analysis](https://3perf.com/blog/notion/)). The one consequence to design around: **CodeMirror 6 is DOM-based, so on React Native the editor runs inside a `react-native-webview`** (bridged to native for content, change events, toolbar actions) — exactly what Notion does. We share *logic*, not UI widgets.

```
apps/
  desktop/   # React (DOM) UI + CodeMirror 6, wrapped by Electron; main process owns the
             # local folder mirror (Node fs). Reusable as a web app later.
  mobile/    # React Native (Expo) UI + CodeMirror 6 inside react-native-webview (bridged).
             # Expo modules: filesystem, share-sheet, secure storage, background sync.
packages/
  core/      # platform-agnostic TypeScript: data models & types, the file-level 3-way-merge
             # sync engine, Supabase client, agent/API client, state stores (e.g. Zustand).
```

Reuse: ~all non-UI logic lives in `packages/core`; the UI layer is built twice (React DOM vs React Native); CodeMirror is the editor on both (direct DOM on desktop, in a webview on mobile). _(Obsidian's all-Capacitor model would have shared UI too, but RN was chosen for a more native mobile feel — [Ryan's call].)_

## Hosting & infra (decided 2026-06-27)
- **Hosting:** **managed Supabase now** (it already runs on AWS) for the demo + private beta — no ops. Stay portable: Supabase is open-source (self-hostable on AWS via Docker) and the DB is plain Postgres (→ RDS/Aurora), so an **AWS-native migration is a scale / data-residency decision for later**, not now. See open-questions O10.
- **Containers:** Docker for our own backend services (e.g. a sync worker) as needed. We do **not** run our own agent sandboxes — Managed Agents handles that; Docker/Firecracker for the agent only matters in the self-hosted/OSS path.
- **Language:** **TypeScript end-to-end**, including AI orchestration (first-class Anthropic TS SDK + Managed Agents). **No Python service for now** — add one only behind a clean API boundary if a genuinely Python-shaped need appears (custom embeddings/vector pipelines, evals, ML).
- **Claude-on-AWS (future option):** if AI billing/IAM should consolidate on AWS, **Claude Platform on AWS** supports Managed Agents (beta); **Amazon Bedrock does not** (Bedrock would force the self-hosted loop).
