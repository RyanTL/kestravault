# Changelog

All notable changes to KestraVault are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release notes for each GitHub Release are pasted from the matching section here.

## [Unreleased]

### Added

- **Breached-password check at sign-up.** New accounts are checked against
  the HaveIBeenPwned corpus via the k-anonymity range API (only the first 5
  characters of the password's SHA-1 are sent, response padding on); breached
  passwords are rejected with a clear message. Fails open if the API is
  unreachable, so an outage can never block sign-up.

## [0.2.0] - 2026-07-09

The cloud release: optional end-to-end vault sync, shared/collaborative vaults,
and beta entitlements. The hosted backend (KestraVault Cloud) is baked into the
build; the local-first desktop app from 0.1.0 continues to work with none of it.
Billing is not live yet — full cloud access during the beta comes from
single-use lifetime access codes.

### Added

- **Cloud out of the box.** Packaged builds ship with the KestraVault Cloud
  endpoint baked in (`apps/desktop/src/main/hosted.ts` — the Supabase anon key
  is a public client credential; RLS is the security boundary). Downloaded
  apps can sign up and sync with zero configuration;
  `KESTRAVAULT_SUPABASE_URL` / `KESTRAVAULT_SUPABASE_ANON_KEY` still override
  for dev, CI, and forks.
- **Lifetime access codes (pre-Stripe beta).** Full cloud access is granted by
  single-use codes (`KV-XXXX-XXXX-XXXX`): a `lifetime_codes` table storing
  SHA-256 hashes only, a `redeem_lifetime_code` SECURITY DEFINER RPC that
  atomically claims a code and upserts an always-active `lifetime`
  entitlement, and a service-role-only `mint_lifetime_codes` helper
  (`scripts/mint-lifetime-codes.mjs`). Redeem in Settings → Sync & sharing →
  **Redeem access code**. All existing entitlement enforcement (vault cap,
  sharing gates, read-only-on-lapse) applies unchanged.

- **Cloud sync + shared vaults (Feature A).** A vault can be linked to a cloud
  workspace and kept synchronized across all devices and members: file-level
  sync engine in `@kestravault/core` (git-style 3-way merge, optimistic
  first-committer-wins commits, soft deletes, edits-beat-deletes, losing edits
  preserved as synced `*.conflict.md` copies), desktop sync loop (on launch,
  on local edits, on Supabase Realtime pushes, and on an interval), and a
  Settings → **Sync & sharing** tab: email+password account, link/create cloud
  vaults, invite up to 3 members with single-use expiring tokens, join by
  token, member list + removal.
- **Owner-pays entitlements.** Creating and sharing cloud vaults requires the
  owner's active paid cloud plan (one plan covers up to **3 cloud vaults**,
  personal and shared); members join free with their own AI key or Claude
  login. A lapsed plan drops the owner's workspaces to read-only — data is
  never locked or deleted. All rules enforced server-side (Postgres triggers +
  RLS), mirrored by a Stripe `billing-webhook` edge function.
- **Self-hosting switch.** Point the app at your own Supabase instance
  (Settings → Sync & sharing → Self-hosted; flip
  `instance_config.self_hosted` in your database) and every billing check is
  bypassed — the full backend ships in this repo (open core).
- **Per-author attribution.** Every synced file version and change-set now
  records which account wrote it (`author_id`), the base for the shared-vault
  change feed.
- **Shared-vault Activity panel.** The right sidebar now shows who is in the
  vault right now — with the note they're editing (Supabase Realtime
  presence) — plus the attributed change feed: every synced edit, by author,
  newest first, click-to-open. Backed by a new `workspace_change_feed` SQL
  function (membership-gated).
- **Change-set revert.** The Activity panel now lists recent agent change-sets
  with a one-click Revert action. Revert applies inverse file versions, records
  the inverse as a manual change-set, marks the original as reverted, and
  refuses to run if any touched file has newer work.
- **Members shown by email.** The Sync & sharing members list resolves user
  ids to account emails via a new `workspace_member_directory` SECURITY
  DEFINER function (clients can't read `auth.users` under RLS); falls back to
  truncated ids against older servers.
- **Images in notes.** Paste or drop an image into the editor and it lands in
  the vault's `assets/` folder with a standard `![](assets/…)` embed; images
  render inline in live preview (raw markdown on the cursor's line,
  Obsidian-style).
- **Asset sync.** Vault images sync alongside notes through a private
  `vault-assets` Supabase Storage bucket (member-scoped RLS) + the `assets`
  table: three-way reconciliation against the last-synced state, delete
  propagation, edits-beat-deletes, and both-sides conflicts kept as
  `*.conflict.*` copies. Pure planner is unit-tested.
- **Brain tab in Settings.** Edit `.kestravault/instructions.md` — the
  plain-language instructions the AI reads on every request — in-app, with a
  path into the setup wizard when a vault has none. (Roadmap: "hidden Brain
  settings".)

### Changed

- **Ingest edge function commits atomically.** Agent writes now go through the
  same `commit_file_version` optimistic-concurrency path as the sync engine
  (version check + files update + history append in one transaction), mark
  the source's frontmatter `status: ingested`, and record real SHA-256
  hashes, ULIDs, and line diffs (previously stubbed).
- **README** now leads with real app screenshots (hero + editor/AI pair).

## [0.1.0] - 2026-07-02

First downloadable release of the KestraVault desktop app — free, open source,
bring-your-own-model. Builds are unsigned for now (see the README for the
macOS Gatekeeper / Windows SmartScreen steps).

### Added

- **Local-first markdown vault** — your notes are plain `.md` files on disk,
  with multiple vaults (Obsidian-style), a vault switcher, and live reload when
  files change outside the app.
- **Editor** — CodeMirror 6 live-preview markdown editing with `[[wikilinks]]`,
  tabs and split groups, a Notion-style `/` slash-command menu, formatting
  shortcuts, clickable task checkboxes, note properties, and drag-reorder in
  the file tree.
- **Navigation** — command palette, quick switcher, full-text search,
  backlinks, outline, bookmarks, daily notes, and an interactive graph view.
- **Bring-your-own-model AI** — chat with your notes using your Claude
  subscription (no API key, sign in like Claude Code), an Anthropic/OpenAI/
  OpenRouter API key, or fully local models via Ollama or LM Studio. API keys
  are encrypted with the OS keychain and never leave your machine except to
  the provider you pick.
- **AI features** — vault-aware Q&A, inline selection rewrite, agentic vault
  operations (Ingest / Lint) sandboxed to the vault, reasoning-effort control,
  per-note Private flag that hides a note's body from remote models, and a
  local-only activity log for time-aware answers.
- **Appearance** — monochrome light/dark/system themes, adjustable font size
  and line width.
- **Update notifications** — the app checks GitHub releases on launch and
  daily, and shows a banner linking to the download page when a newer version
  exists. Notify-only (nothing auto-installs), with an off switch in
  Settings → About that stops all update-related network calls.

[Unreleased]: https://github.com/RyanTL/kestravault/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RyanTL/kestravault/releases/tag/v0.2.0
