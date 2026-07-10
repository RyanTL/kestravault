# Roadmap & Tracker

_Update the checkboxes as work lands. Three phases: **Private Beta → MVP → Post-MVP.**_

## Phase 0 — Private Beta (Ryan + people he knows) **[Ryan's call: a private beta precedes the MVP]**

Goal: dogfood the core loop, refine the agent + schema, de-risk before any public launch. **No billing** — cover cost / use BYO-key.

Suggested sequencing: start on **one platform** (likely desktop — closest to Ryan's current Obsidian + Claude Code workflow) to move fast, then bring the second platform in. _(Flexible.)_

- [x] **Stack decided (2026-06-27): Electron desktop + React Native (Expo) mobile + React/TS + CodeMirror 6.** (See architecture.md.)
- [ ] Monorepo scaffold: `packages/core` (shared logic) + `apps/desktop` (Electron) + `apps/mobile` (Expo).
- [ ] Cloud backend skeleton (Supabase): auth, canonical markdown store, one workspace per user.
- [ ] Three-zone data model (`sources/`, `wiki/`, `notes/` + `index`, `log`, hidden instructions).
- [ ] Capture: **paste text / markdown**. [MVP capture scope]
- [ ] Cloud agent via **Managed Agents**: ingest operation (source → wiki page → index/cross-refs → log).
- [x] **Change feed + undo** for agent edits. _(2026-07-04: the attributed **change feed UI** is built — right-sidebar Activity panel over `workspace_change_feed`, plus live presence. 2026-07-08: one-click change-set revert is built — it applies inverse file versions, marks the original change-set reverted, and refuses to overwrite newer human/agent work.)_
- [ ] **Query with citations.**
- [x] Manual note editing (**CodeMirror 6**) — desktop: on-disk vault, file tree CRUD with **drag-to-move**, Obsidian-style Live Preview, wikilinks, **Notion-style header** (tabs → breadcrumb path → editable inline title), **clean new notes** (no boilerplate, properties hidden until added), tabs + split panes, quick switcher (⌘O), command palette (⌘P), search (⌘⇧F), right-sidebar outline + backlinks. _(local-only, no sync/agent yet)_
- [x] **Desktop AI assistant (Notion-style), running on the user's Claude subscription — no API key.** Right-side **Ask AI** chat panel (⌘J) with streaming, page-scoped vs whole-vault context, source citations, model picker (Sonnet/Opus), and page actions (summarize / improve / action items / translate). Notion-style **"Search or ask AI"** (⌘⇧F) with an Ask-AI row + page matches + highlighted full-text hits. Powered by `@anthropic-ai/claude-agent-sdk` in the Electron main process (subscription OAuth, same login as Claude Code); graceful "Connect your Claude account" state until the user runs `claude /login` once. _(Local-dev stand-in for the cloud Managed Agent; the ingest/agent loop still lands separately.)_
- [x] Hidden **Brain settings** (plain-language instructions editor). _(2026-07-04: Settings → Brain edits `.kestravault/instructions.md` in-app — load/save/discard, plus a "Set up my brain" path when a vault has no instructions yet.)_
- [x] **Onboarding (desktop, local):** pick intent → questions (purpose, topics, about-you, style, language, ingest mode, wiki categories) → scaffolds zones + `.kestravault/instructions.md` (+`AGENTS.md`/`CLAUDE.md` stubs so Claude Code & Codex/ChatGPT follow the same schema in the vault folder) → optional **AI-personalized** instructions when a provider is connected, template fallback otherwise. Triggers on any vault without a marker (first launch / new vault / opened folder) + a "Set up my brain" command to re-run. _(Cloud/Managed-Agents onboarding still separate.)_
- [x] **Vault skills — Ingest & Lint (desktop, local agent).** Chat-panel skills run a real tool-using Agent SDK loop sandboxed to the vault (writes only `wiki/**`, `index.md`, `log.md`; `sources/`, `notes/`, `.kestravault/` protected), with live progress + changed-file chips. Claude subscription / Anthropic API only; other providers keep chat.
- [ ] Model routing (Haiku grunt / Sonnet-Opus synthesis); async ingestion.
- [x] Sync to a real local folder on desktop (mirror). _(2026-07-03: file-level sync engine in `packages/core/src/sync/` — pull/push over the canonical store, git-style 3-way merge, optimistic `commit_file_version` commits, soft deletes, edits-beat-deletes, first-committer-wins `*.conflict.md` copies; desktop loop in `main/sync.ts`: launch + debounced local changes + Supabase Realtime + interval, Settings → “Sync & sharing”. Needs a live Supabase project to run against — see NEEDS-RYAN.md. **2026-07-04:** members list shows emails (`workspace_member_directory`), presence + attributed change-feed UI in the right sidebar, and **images**: paste/drop into notes, inline render, asset sync via the `vault-assets` storage bucket with conflict copies.)_
- [x] **BYO-key / bring-your-own-model support.** Settings → AI model lets the user run the AI on their Claude subscription (OAuth, no key), an API key (Anthropic / OpenAI / OpenRouter), or a local model (Ollama / LM Studio / any OpenAI-compatible endpoint). **Keys are encrypted at rest** in the OS keychain (Electron `safeStorage`), held only in the main process, and never written to `localStorage` or sent over IPC to the renderer; legacy plaintext keys are migrated automatically. Includes a per-provider "Test connection" probe.
- [x] **Open-source launch hygiene + security hardening.** MIT `LICENSE`, rewritten `README`, `SECURITY.md`, `CONTRIBUTING.md`; Electron navigation guard + safe external-link handling; `javascript:`/`data:` link sanitization in rendered markdown.
- [x] **Desktop packaging (electron-builder).** `build:mac` / `build:win` / `build:linux` scripts produce .dmg + .zip (macOS), NSIS .exe (Windows), AppImage + .deb (Linux); app icon + mac entitlements included; workspace deps bundle correctly under pnpm (verified). Builds are **unsigned** until Apple Developer ID / Windows code-signing creds are added.
- [x] **Self-host stack (`selfhost/`) + Settings → Sync server** (2026-07-03). Slim Supabase compose for a home server (Tailscale sidecar profile: HTTPS at a MagicDNS name, no open ports; studio profile; setup/migrate/backup scripts; full README) + desktop field for custom server URL (anon key in the encrypted secret store) with a "Test connection" probe. _Needs one real `docker compose up` smoke test before announcing. The sync engine itself is still Phase 0/1 work; the portable agent loop for self-host AI stays Post-MVP._ See [self-hosting.md](self-hosting.md).

## Phase 1 — MVP (public)

Goal: smallest lovable public product. **Native desktop + native mobile.** **[Ryan's call: both native apps in the MVP, not web-first]**

- [ ] Second native client to parity (**React Native / Expo** mobile).
- [ ] Full offline (desktop) + cached/queued offline (mobile).
- [ ] **Multiple workspaces** (single user) — personal vs business, isolated. [vision #5]
- [ ] **Billing on:** free metered tier + paid (~$15) quota via Stripe; BYO-key escape; overage credits.
- [ ] Quota metering + usage dashboard.
- [ ] Hardening: 3-way merge conflict handling, change-feed polish, error/retry UX.
- [x] Design pass: dark-first minimal theme, light mode. _(desktop: light/dark/system switch, title-bar toggle)_
- [x] **Open-core = full Cal.com model (revised 2026-07-03):** one public repo, everything (apps + `core` + `supabase/` backend + billing) **AGPLv3** — no repo split, no closed backend. MIT→AGPLv3 relicense **done** (dependency-license audit → swapped `LICENSE` + `package.json` license fields + README/CONTRIBUTING). **Relicensed back to MIT 2026-07-09 (Ryan, post-launch).** See [sync-collab-open-core.md](sync-collab-open-core.md). _Remaining: `NOTICE` line for the bundled proprietary `@anthropic-ai/claude-agent-sdk`._
- [ ] **Update notifications (free tier — no code signing).** On launch (and periodically), the app checks the GitHub Releases API for a newer tagged version and shows an in-app "Update available" banner/button. The button opens the GitHub release / website download page; the user installs the new build manually. **Notification only — no silent auto-install.** Include a settings toggle to disable update checks (respect users who don't want any network calls). Website download buttons point at the stable `github.com/RyanTL/kestravault/releases/latest/download/<file>` URLs. **[Ryan's call (2026-07-02): ship the free notify-and-manual-download flow for the open-source launch; defer signed silent auto-update to when the iOS app work happens — same Apple Developer $99/yr covers both.]**
- [ ] **Release automation.** GitHub Actions workflow that builds macOS + Windows + Linux and drafts a GitHub Release on tag push (`v*`), with changelog. Keeps releases consistent so the update-notification check has a reliable source of truth.

## Phase 2 — Post-MVP (backlog)

- [ ] **Signed builds + silent auto-update (paid tier).** Do this alongside the iOS launch. macOS: enroll in the **Apple Developer Program ($99/yr — one membership covers macOS signing/notarization _and_ the iOS App Store**; decide individual vs organization enrollment early, org needs a D-U-N-S number). Windows: **Azure Trusted Signing (~$10/mo)** or a traditional OV/EV cert (~$200–600/yr). Linux: AppImage, no signing needed. Then wire up **`electron-updater`** for one-click download-and-restart installs (requires the signing above; replaces the manual-download flow from Phase 1).
- [ ] **Shared workspaces (up to 4: owner + 3) — first Post-MVP collab priority** (re-scoped 2026-07-03, supersedes 2-person pair sharing): a paying owner shares a workspace with **a max of 3 members**; **owner's paid cloud+sync plan funds hosting/sync; members join free with an account + their own AI key**; owner/member roles; **3-member cap enforced server-side**; all AI is member-BYO client-side (managed agent doesn't run here → depends on the portable agent loop); merge + presence (no CRDT); **first-committer-wins → `*.conflict.md`** (conflict UX O8 designed first); private chats; attributed change feed. See [sync-collab-open-core.md](sync-collab-open-core.md). _(2026-07-03: core is BUILT — membership/invites/RLS, entitlements (plan-gated creation + **3-cloud-vault cap** + lapsed→read-only + self-host bypass), sync engine with conflict copies, per-version author attribution, Stripe webhook, desktop invite/join/members UI. Remaining: presence, change-feed UI, member-email display, Stripe/live-project setup — NEEDS-RYAN.md.)_
- [ ] **Note publishing (public read-only link)** — publish a single `notes/` file as a public web page (`[[wikilinks]]` flattened to plain text = no graph leak; per-asset public image URLs; live; anonymous; revocable; AI stays out). **Sequenced behind the web app (O4)** — a public link needs a browser-reachable render route, which doesn't exist yet. See [sync-collab-open-core.md](sync-collab-open-core.md).
- [ ] **Teams** (~$50 plan, company pays, members ride free): org billing, roles/permissions, shared managed-agent credit pool — generalizes shared workspaces past the 4-person cap. (O6)
- [ ] More capture: **upload files** (PDF/.docx/.md/.txt), **URL → fetch & convert**, **mobile share-sheet**, browser **web clipper**, email-in, voice → transcribe.
- [ ] **Import** from Notion / Obsidian.
- [ ] **Lint** operation (contradictions, stale claims, orphans, missing cross-refs, data-gap web searches).
- [ ] **Graph view** (Obsidian-style).
- [ ] Output formats: slide decks (Marp), charts, comparison tables, canvases — filed back into the wiki.
- [ ] Dataview-style queries over frontmatter.
- [ ] Local-only / self-host runtime (portable agent loop, any provider).
- [ ] Templates gallery.
- [ ] Web app (cheap, given shared React) — optional.
- [ ] Wiki search engine at scale (BM25 + vector; e.g. `qmd`-style) when index.md alone stops scaling.

## Definition of "smallest lovable" (the wow)

Drop a source → within moments the wiki has a new page, updated cross-references, and a visible "here's what I changed" feed → ask a question → get a cited answer that can be filed back. All without touching a terminal, on a device you already use.
