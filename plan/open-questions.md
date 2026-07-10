# Open Questions & Risks

_Unresolved decisions and known risks. Resolve and migrate into the decision log as they close._

## Open decisions
| # | Question | Notes / leaning |
|---|---|---|
| O1 ✅ | **Desktop shell — RESOLVED: Electron** (2026-06-27). | Chosen for demo speed, rendering consistency with the mobile webview, and Node FS for the folder-mirror; matches Notion & Obsidian. Mobile stays React Native (Expo) — Notion's exact combo. Tauri kept as a possible later footprint optimization. |
| O2 | **Hero use case for launch marketing?** | Engine is general [Ryan's call]. But a launch still benefits from one polished hero demo. Candidates: research/deep-dives (best demo), personal PKM (broadest), business brain (Ryan's own pain), learning. Decide before public launch, not before build. |
| O3 | **Product name.** | "KestraVault" is a placeholder. |
| O4 | **Ship a web app at all, and when?** | Ryan chose native desktop + mobile for MVP. A web app is cheap given shared React and would broaden reach — likely Post-MVP/optional. |
| O5 | **Free-tier exact limits** (ingests/queries per month) and overage credit pricing. | Tune against real beta usage + the unit-economics model. |
| O6 | **Teams plan specifics** (~$50): per-seat vs flat, permission model. | Deferred with teams. **Shared workspaces of up to 4 (owner + 3) come first** (re-scoped 2026-07-03, supersedes 2-person pair sharing); Teams is the path past the 4-person cap — see [sync-collab-open-core.md](sync-collab-open-core.md). |
| O11 | **Does owner-funds-hosting for free members scale?** (shared workspaces) | Grill 2026-07-03 chose: owner's paid cloud+sync plan covers hosting/sync; up to 3 members join free with their own AI key (company model-spend = $0 for shared workspaces). Sync/hosting cost of free members is small and now **bounded by the 3-member cap** — revisit a per-seat hosting fee only if abused; Teams handles larger groups. "For now" call. |
| O12 | **Note publishing depends on a web surface (O4).** | A public read-only note link needs a browser-reachable render route; today there's only Electron + RN. Publishing is **designed** (flatten `[[links]]`, `notes/`-only, live, anonymous, revocable) but **build is sequenced after the web app / a minimal hosted render route.** Also open: unlisted+`noindex` (default) vs allow-indexing toggle. |
| O7 ◑ | **How the wiki mounts into the Managed Agents container & flows back.** | **v1 approach specced in [agent-loop.md](agent-loop.md)** — mount workspace files per session → agent edits → diff back into an atomic change-set → apply as new versions → change feed + undo. Still to **validate in the build** (hello-world ingest). Managed Agents is beta — keep the portable loop as fallback. |
| O8 | **Conflict UX details** — what a true clash looks like to the user. | **Ship-blocking for shared workspaces.** Rule chosen (2026-07-03): **first-committer-wins; the later edit becomes a `*.conflict.md` copy** and is flagged — the UX for surfacing/resolving that copy is the open design. Even 4 humans clash far more than one. See [sync-collab-open-core.md](sync-collab-open-core.md). |
| O9 | **Search at scale** — when index.md stops scaling, what replaces it (BM25 + vector / `qmd`-style). | Post-MVP. |
| O10 | **When/whether to migrate to AWS-native** (self-host Supabase on AWS, or RDS/Cognito/S3). | Deferred by design: start on managed Supabase (already on AWS), migrate only when scale or data-residency requires. DB is plain Postgres → clean RDS path. |

## Risks to watch
- **Unit economics:** agentic ingestion is expensive; the whole free/quota/BYO-key/tiered-model/async design exists to contain this. Re-validate with real beta usage before turning on a public free tier.
- **Scope:** native desktop + native mobile in the MVP is ambitious for a small team — Phase 0 (private beta on one platform first) is the pressure valve.
- **"Good at everything" vs focus:** declining a hero use case risks a diffuse launch; mitigated by keeping the engine general but choosing a demo focus at launch (O2).
- **Managed Agents is beta:** API churn / availability risk; keep the portable agent loop viable as a fallback and for the self-host path.
- **Lossy editor temptation:** if a future WYSIWYG editor is added, protect the lossless-markdown invariant.
- **Trust:** the change-feed + undo + "your edits always win" are load-bearing for user trust in an app that auto-edits your knowledge base — don't compromise them for convenience.
