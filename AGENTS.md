# AGENTS.md — KestraVault

Single source of truth for **any** agent (Claude Code, Codex, others) or human working in this repo.
Claude Code reads `CLAUDE.md`, which points here. Keep shared rules in **this** file so every agent stays in sync.

## What this is
An open-source, AI-first second brain: an AI agent organizes, cross-links, and indexes the user's markdown notes inside a structure the **user** chooses (defined in each vault's AI guide, `.kestravault/instructions.md`). Full plan in **`./plan/`** — read `plan/README.md` first.

## Stack (locked — see `plan/architecture.md`)
- **TypeScript everywhere.** Monorepo (pnpm workspaces + turborepo).
- `packages/core` — platform-agnostic logic: data models, sync engine, Supabase client, agent/API client, state stores. **No DOM / Electron / RN imports.**
- `apps/desktop` — React (DOM) + CodeMirror 6, wrapped by **Electron**.
- `apps/mobile` — React Native (**Expo**) + CodeMirror 6 inside a WebView.
- `supabase/` — schema, migrations, edge functions.
- Backend: **Supabase** (Postgres/auth/storage/realtime). Cloud agent: **Anthropic Managed Agents**. Editor: **CodeMirror 6**. Sync: **file-level git-style 3-way merge**.

## Commands
```
pnpm install
pnpm build          # turborepo: builds packages (core) in dependency order
pnpm typecheck      # MUST pass before a PR
pnpm lint           # MUST pass before a PR
pnpm test           # MUST pass before a PR
pnpm --filter @kestravault/desktop dev     # run desktop  (placeholder until the Electron shell lands)
pnpm --filter @kestravault/mobile  start   # run mobile   (placeholder until the Expo app lands)
```
Packages are scoped `@kestravault/*` (`core`, `desktop`, `mobile`). Shortcuts: `pnpm dev:desktop`, `pnpm start:mobile`.

## Ground rules
- **Markdown is the source of truth.** Never swap CodeMirror for a lossy WYSIWYG editor.
- **The vault's structure belongs to the user.** Never hard-code a folder layout; the AI guide (`.kestravault/instructions.md`) defines each vault's structure and the agent's rules. Agent ops may create/edit/move notes but never delete, and app metadata (dotfiles) stays read-only except the guide itself.
- Keep `packages/core` platform-agnostic.
- **Secrets:** read from env only; never hardcode or commit keys.
- Small PRs, one scoped task each, conventional commits.

## Parallel-agent rules (CRITICAL — full playbook in `plan/agent-workflow.md`)
- **One agent per package/area per task.** Never edit a file another agent is actively changing.
- Work in your **own git worktree + branch**; integrate via **PR** (CI must be green).
- **Only the designated integrator** changes root config / `package.json` / lockfile / shared `core` types / DB migrations.
- Talk through **interfaces at package boundaries** — don't reach into another package's internals. Need something from another area? Propose the interface in an issue/PR; don't edit it yourself.

## Where to look
`plan/README.md` (index) → `vision.md`, `architecture.md`, `data-model.md`, `agent-loop.md`, `roadmap.md`, `open-questions.md`, `agent-workflow.md`, `setup.md`.
