# Multi-Agent Workflow

How to run 2–3 AI coding agents (Claude Code primarily, plus Codex and others) in parallel on this repo **without them breaking each other's work.**

## The problem
Multiple agents editing the same working tree at once = clobbered files, merge chaos, broken builds. We prevent that with three pillars: **Partition → Isolate → Integrate.**

## Pillar 1 — Partition by package
The monorepo boundaries are the seams. Assign **at most one agent per area per task:**

| Area | Owns |
|---|---|
| `packages/core` | data models, sync engine, Supabase client, agent/API client, state (platform-agnostic) |
| `apps/desktop` | Electron + React (DOM) UI + CodeMirror |
| `apps/mobile` | Expo RN UI + CodeMirror-in-WebView |
| `supabase/` | schema, migrations, edge functions |
| `plan/`, `AGENTS.md` | docs/specs (usually you) |

Agents talk through **interfaces at package boundaries**, never by reaching into another package's internals. If agent B needs something from `core`, the `core` owner exposes a typed function and B consumes it. Missing interface? Propose it in an issue/PR — don't edit someone else's area.

## Pillar 2 — Isolate with git worktrees
A **worktree** is a second working directory backed by the same repo, checked out to a different branch. Give each agent its own — they edit different folders on disk, so they physically cannot overwrite each other:

```sh
# from the main checkout
git worktree add ../kestravault-core    feat/core-sync       # agent A
git worktree add ../kestravault-desktop feat/desktop-shell   # agent B
git worktree add ../kestravault-mobile  feat/mobile-shell    # agent C
```
Open one agent per folder. Clean up after merge: `git worktree remove ../kestravault-core`.

## Pillar 3 — Integrate via PR + CI
Each agent: small scoped task → commits on its branch → opens a **PR** → **CI** runs `typecheck`/`lint`/`test` → you (or a review agent) review → squash-merge. Keep branches short-lived; rebase on `main` before merging. CI is the guardrail that catches a parallel agent's breakage before it lands.

## Cross-agent compatibility (Claude Code + Codex + others)
- **`AGENTS.md` (root) is the single source of truth** for conventions, commands, and rules. Codex and most agents read it natively.
- **`CLAUDE.md` is a thin pointer** to `AGENTS.md`, so Claude Code uses the same rules — don't duplicate them.
- **Nested `AGENTS.md`** inside a package extends/overrides root rules for that package (both Claude Code and Codex respect the nearest one).
- Keep commands **tool-agnostic** (plain pnpm scripts) so any agent runs install/build/test identically.

## Assigning work (so two agents never grab the same task)
Use **GitHub Issues** (one issue per task → one branch) or a simple `TASKS.md`. Each task names: the **area** it touches, the **interface** it exposes/consumes, and the **acceptance check** (the command that must pass).

## Contention hazards & rules
- **Root config / lockfile / shared deps:** only the designated **integrator** (or you) edits `package.json`/`pnpm-lock.yaml`/root `tsconfig`. Others request deps in their PR description.
- **Shared `core` types:** a widely-used type change ripples everywhere — its own small PR, merged first, then others rebase.
- **DB migrations:** serialize — one numbered migration PR at a time; never two in parallel.
- **Generated files** (e.g. Supabase types): regenerate, don't hand-edit; one owner.

## The loop, per agent
1. `git worktree add ../kestravault-<area> feat/<task>`; open the agent there.
2. Point it at `AGENTS.md` + the relevant `plan/` spec.
3. Do the one scoped task; run `pnpm typecheck && pnpm lint && pnpm test`.
4. Commit (conventional commits), push, open a PR stating the acceptance check.
5. You review/merge; `git worktree remove` the folder.

## Claude Code specifics
- Run **2–3 Claude Code sessions**, each `cd`'d into its own worktree folder — the simplest robust parallelism.
- **Subagents** (the Task tool) are for fan-out *within* one session (explore/edit many files at once); for independent feature work prefer **separate sessions/worktrees**.
- Sessions can run in the **background** and notify you on completion.

## Codex specifics
- Codex reads `AGENTS.md` and works on a branch in its worktree the same way; review its diff/PR before merge.
- Because the rules live in `AGENTS.md` (not Claude-only files), Codex follows the same Partition/Isolate/Integrate discipline.

## Worked example — the hello-world ingest with 3 agents
- **Agent A (`packages/core`)** — define `Workspace`/`File`/`ChangeSet` types + the Supabase client + an `ingestSource()` interface (stubbed). PR #1.
- **Agent B (`supabase/`)** — schema + migrations for `files`/`file_versions`/`change_sets` per `data-model.md`. PR #2.
- **Agent C (`apps/desktop`)** — the primary-surface shell (tree + editor + AI panel) consuming `core`'s interfaces (mocked until A merges). PR #3.
- **Integration order:** merge A + B (foundations) → rebase C → wire C to the real `ingestSource()`. CI green at every step.
