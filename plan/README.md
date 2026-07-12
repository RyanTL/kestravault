# KestraVault — Project Plan

> Working name: **KestraVault** (placeholder — see [open-questions.md](open-questions.md)).

An open-source, **AI-first "second brain"**: an AI agent organizes, cross-links, and indexes your markdown notes inside a structure **you** choose — *magic by default, full control on demand.* Native desktop + mobile, synced.

> **2026-07-11 — structure redesign.** The product no longer imposes a fixed folder layout (the original three-zone `sources/wiki/notes` design described in the older docs below). Each vault's structure now comes from onboarding and lives in the vault's **AI guide** (`.kestravault/instructions.md`): purpose + working rules + a **vault map** (an index the agent keeps current so it never scans every file). Users who want a wiki-style setup can still build one — it's their choice. Older plan docs are kept as the decision log.

## The problem we solve
People are building powerful AI-assisted second brains by pairing a notes app with a terminal coding agent, but that setup:
- is hard to set up for non-technical people,
- is local-only unless you self-host,
- can't run on a phone,
- requires two separate apps,
- and typically forces someone else's organizational system.

We collapse all of that into one synced, cross-platform, AI-first app.

## How to use these docs
| Doc | What's in it |
|---|---|
| [vision.md](vision.md) | What we're building and why — the full **decision log** (every locked decision + rationale + where Ryan overrode the recommendation). |
| [architecture.md](architecture.md) | Technical architecture, agent runtime, sync, stack, hosting. |
| [data-model.md](data-model.md) | Exact per-workspace file layout, zones, frontmatter, canonical store, sync/versioning. |
| [agent-loop.md](agent-loop.md) | The ingest & query loops step by step, Managed Agents session flow, model routing, cost controls. |
| [roadmap.md](roadmap.md) | Phases (**Private Beta → MVP → Post-MVP**) with trackable checklists. **Keep this updated as we build.** |
| [launch-v1.md](launch-v1.md) | The v1 free-launch execution plan: release CI, unsigned mac/win downloads via GitHub + website, update notifications. |
| [sync-collab-open-core.md](sync-collab-open-core.md) | Sync + **shared workspaces (up to 4: owner + 3, owner-funds-hosting/members-BYO-key)** + **note publishing (public read-only links)** + the open-core model: **one fully open repo, backend included (Cal.com-style; MIT since 2026-07-09)**, hosted service = the business. |
| [self-hosting.md](self-hosting.md) | Run the whole stack yourself — **home server + Tailscale** (MagicDNS, free TLS, works behind CGNAT). **Built 2026-07-03:** `selfhost/` compose stack + scripts + desktop Settings → Sync server. Honest gap: managed agent → portable BYO-key loop (Post-MVP). |
| [open-questions.md](open-questions.md) | Unresolved decisions and known risks. |
| [agent-workflow.md](agent-workflow.md) | How to run 2–3 AI agents in parallel without collisions (Claude Code + Codex). |
| [setup.md](setup.md) | Manual setup checklist — accounts/secrets only you can create. |

## Status
- **Phase:** Planning (pre-build). Vision locked **2026-06-27**.
- **Stack: locked** (2026-06-27) — Electron desktop + React Native (Expo) mobile + React/TS + CodeMirror 6 + Supabase + Managed Agents. See [architecture.md](architecture.md).
- **Data model + agent loop: specced** (2026-06-27) — see [data-model.md](data-model.md) + [agent-loop.md](agent-loop.md).
- **Immediate next action:** scaffold the monorepo (`packages/core` + `apps/desktop` + `apps/mobile`) and prove a **hello-world ingest** (paste a source → agent edits land back as a clean change-set with working undo). This validates open question O7.

## One-line vision
Write notes and ask questions; an AI agent keeps your vault organized, interlinked, and indexed — *your structure, always findable* — across all your devices, with the AI machinery hidden until you ask for it.
