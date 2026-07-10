# v1 Free Launch Plan — downloadable desktop app (GitHub + website)

_Goal: anyone can download and run KestraVault desktop on **macOS and Windows** (Linux as a bonus, since it already builds) from **GitHub Releases** and a **website**, free, unsigned builds. Covers roadmap items "Update notifications" and "Release automation" plus everything around them._

**Decision context (locked 2026-07-02):** free launch ships **unsigned** builds with a notify-and-manual-download update flow. Code signing + silent auto-update is deferred to Phase 2 (alongside iOS / Apple Developer enrollment).

**Privacy until launch (Ryan, 2026-07-02):** the repo **stays private until everything is near-perfect** — nothing gets leaked early. "Open-sourcing" is a **launch-day step** (flip the repo public), not a prerequisite. Implications:

- All Phase A–C work happens in the private repo; release workflow output stays as **draft releases** (invisible to outsiders).
- GitHub download URLs, the update-check API, and website download buttons **only work once the repo is public** — build them now, they light up at flip time.
- The website can be developed in-repo but **must not be deployed** until launch day.
- Add a **pre-flip sweep** to the launch checklist: audit full git history for secrets/keys/personal data (`gitleaks` or similar), review `plan/` and docs for anything Ryan doesn't want public, confirm `.env`/local files were never committed. If history is dirty, decide: scrub vs. fresh-history public repo.
- **License relicense (revised 2026-07-03 — full Cal.com model):** everything stays in this one repo and goes public under **AGPLv3** (no backend split; see [sync-collab-open-core.md](sync-collab-open-core.md)). Pre-flip task: **audit dependency licenses**, then swap MIT→AGPLv3 across `LICENSE`, both `package.json` `license` fields, README, and CONTRIBUTING. Since the backend (`supabase/` etc.) now goes public too, the secret/history sweep must cover it — no keys or personal data anywhere in history.

## Where we are

| Area | Status |
|---|---|
| App functionality | ✅ Desktop app works (vault, editor, BYO-model AI, keychain-encrypted keys) |
| Local packaging | ✅ `build:mac` / `build:win` / `build:linux` via electron-builder (dmg+zip / NSIS / AppImage+deb) |
| Versioning | ❌ still `0.0.0`, no tags, no CHANGELOG |
| Release CI | ❌ CI only verifies; no build-and-release workflow |
| mac architectures | ❌ builds host arch only; need **arm64 + x64** artifacts |
| Update notifications | ❌ not implemented |
| Website | ❌ doesn't exist |
| GitHub releases / download docs | ❌ none yet |

## Phase A — Release engineering (blocking)

1. **Versioning + changelog.**
   - Bump `apps/desktop/package.json` to `0.1.0` (electron-builder takes the version from here). Decide: tag = `v0.1.0`, tags drive releases.
   - Add root `CHANGELOG.md` (Keep-a-Changelog style); release notes are pasted from it.
   - Show the app version in Settings/About (read from `app.getVersion()`), so users can compare against the update banner.

2. **mac dual-arch builds.** Change `build:mac` (or the release workflow invocation) to `electron-builder --mac --arm64 --x64`. Artifact names already include `${arch}`. Electron-builder ad-hoc-signs mac builds by default — keep that (required for arm64 to launch at all).

3. **Release automation (roadmap Phase 1 item).** `.github/workflows/release.yml`, triggered on tag push `v*`:
   - Matrix: `macos-14` (dmg+zip, arm64+x64), `windows-latest` (NSIS exe), `ubuntu-latest` (AppImage+deb).
   - Steps: pnpm install → `pnpm build` (core first) → `electron-builder` per-OS → upload artifacts.
   - Final job: generate `SHA256SUMS.txt`, create a **draft** GitHub Release with all artifacts + changelog section; Ryan reviews and publishes.
   - Guard: workflow fails if the git tag ≠ `apps/desktop` package version.

4. **Smoke-test the packaged builds** (not just dev mode): fresh macOS (both arches if possible) and a fresh Windows VM. Verify: first-run vault creation, editor basics, each AI provider path degrades gracefully (esp. "Connect your Claude account" state when `claude` CLI isn't installed — most downloaders won't have it), keychain storage on Windows (DPAPI), external-change watching, quit/relaunch persistence.

## Phase B — Update notifications (roadmap Phase 1 item)

- Main process checks `https://api.github.com/repos/RyanTL/kestravault/releases/latest` on launch + every ~24h; compare semver against `app.getVersion()`.
- In-app "Update available" banner → button opens the GitHub release page (or website downloads page) in the default browser. **No auto-install.**
- Settings toggle **"Check for updates"** (default on); when off, zero network calls. Fail silently on network errors/rate limits.
- Ship this **inside v0.1.0** — it's the mechanism that lets v0.1.0 users learn about v0.2.0.

## Phase C — Distribution surfaces

1. **GitHub Releases as the canonical download source.**
   - README: add a **Download** section at the top — badge + links to `releases/latest`, per-OS install instructions.
   - **Unsigned-build install notes** (put in README, website, and every release body):
     - macOS: Gatekeeper will warn — right-click → Open (or System Settings → Privacy & Security → Open Anyway).
     - Windows: SmartScreen "Windows protected your PC" → More info → Run anyway. Some AV may flag unsigned NSIS; note it's expected and link the checksums.
   - Note: `releases/latest/download/<file>` URLs embed the version in the filename, so the website should **query the releases API client-side** (or be updated per release) rather than hardcoding filenames.

2. **Website** (static landing page; deploy on Vercel or GitHub Pages).
   - Content: one-liner, screenshots (reuse `UI-images/`), the privacy/BYO-model pitch, Download buttons (macOS arm64/Intel, Windows, Linux) resolved via the GitHub releases API, install-warning notes, links to repo/roadmap/security.
   - Needs a decision: domain (buy one vs `*.vercel.app` / `github.io` for v1). Cheap to defer — buttons work either way.

3. **Repo launch hygiene** (mostly done — remaining):
   - Issue templates (bug / feature) + PR template; enable GitHub Discussions for support.
   - Fill README screenshot/GIF of the app (first impression for the release traffic).

## Phase D — Launch

- Run the **pre-flip sweep** (secret/history audit above), then **flip the repo public**.
- Publish `v0.1.0` release (from the drafted workflow output).
- Point website live, verify all download buttons on a machine that has never seen the repo.
- Announce (X/HN/Reddit r/ObsidianMD etc. — Ryan's call on channels/timing).
- Watch issues; patch releases (`v0.1.x`) exercise the same tag-push pipeline.

## Explicitly out of scope for v1 (already tracked elsewhere)

- Code signing / notarization + `electron-updater` silent updates (Phase 2, roadmap).
- Cloud sync, Supabase backend, managed agent loop, billing, mobile app.
- Homebrew cask / winget / Microsoft Store (nice post-launch; winget benefits from signing).

## Overnight agent worklist (no Ryan needed — pure coding)

_Everything here is code/docs inside the private repo: no publishing, no accounts, no deploys, nothing irreversible. Each item is a separate small PR-sized change; `pnpm typecheck && pnpm lint && pnpm test` must pass after each._

1. **Version + About** — bump `apps/desktop` to `0.1.0`; add root `CHANGELOG.md`; surface `app.getVersion()` in Settings/About.
2. **Release workflow** — `.github/workflows/release.yml`: tag-push `v*` trigger, macOS/Windows/Linux matrix, dual-arch mac (`--arm64 --x64`), SHA256SUMS, **draft** release with changelog, tag↔version guard. (Safe to land now: tags are the trigger and only Ryan pushes tags; drafts stay private.)
3. **Update-notification feature** — main-process semver check against the releases API (handle 404/private gracefully — it will 404 until launch), in-app banner opening the release page, settings toggle (default on), zero network calls when off. Unit-test the semver compare + response parsing.
4. **README download section + unsigned-install instructions** (mac Gatekeeper, Windows SmartScreen) — written as if public; harmless while private.
5. **Issue templates + PR template** (`.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`).
6. **Landing page** — static site in `apps/website/` (or `website/`): hero, screenshots from `UI-images/`, privacy/BYO-model pitch, download buttons resolving latest artifacts via the GitHub releases API with graceful "coming soon" fallback while private. **Build only — do not deploy.**
7. **Secret sweep tooling** — add a `gitleaks` (or equivalent) config + CI job / script and produce a report of any historical hits for Ryan to review. Report only — no history rewriting.
8. **Packaged-build sanity script** — script/CI job that runs `electron-builder --dir` and asserts the app bundle contains `@kestravault/core` and launches headlessly (smoke check for the pnpm-hoisting issue).

**Needs Ryan (don't attempt overnight):** flipping the repo public, pushing tags / publishing releases, buying a domain, deploying the website, Apple/Windows signing accounts, VM smoke tests on real machines, announcements.

## Suggested order & sizing

| # | Task | Size |
|---|---|---|
| 1 | Version bump + CHANGELOG + About/version display | S |
| 2 | Release workflow (multi-OS matrix, draft release, checksums, dual-arch mac) | M |
| 3 | Update-notification banner + settings toggle | M |
| 4 | Packaged-build smoke tests (mac + Windows VM) | M |
| 5 | README download section + unsigned-install docs + issue templates | S |
| 6 | Landing page + deploy + download buttons via releases API | M |
| 7 | Tag `v0.1.0`, publish, verify end-to-end, announce | S |

1–3 are code; 4 is QA; 5–6 can run in parallel with 2–3. Realistic path: one focused week.
