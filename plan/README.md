# KestraVault — Project Plan

> Working name: **KestraVault** (placeholder — see [open-questions.md](open-questions.md)).

An open-source, **AI-first "second brain"**: a cloud agent maintains a living, interlinked **wiki** from your **raw sources** — *magic by default, full control on demand.* Native desktop + mobile, synced.

It productizes Andrej Karpathy's ["LLM Wiki" pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and removes its friction: no terminal, works on your phone, one app instead of two (Claude Code + Obsidian), syncs everywhere, and is approachable for non-technical people.

## The problem we solve
People are building powerful second brains with **Obsidian + Claude Code**, but it:
- is hard to set up for non-technical people,
- is local-only unless you self-host,
- can't run on a phone (no Claude Code on mobile),
- requires two separate apps.

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
Drop in sources and ask questions; an AI agent compiles and continuously maintains an interlinked wiki — *integrate once, keep fresh* — across all your devices, with plain manual notes whenever you want them and the AI machinery hidden until you ask for it.
