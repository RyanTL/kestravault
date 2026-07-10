# Sync, Collaboration & Open-Core Model

_Locked 2026-07-02, **open-core model revised 2026-07-03 (Ryan): full Cal.com-style open source — one AGPLv3 repo, backend included.** **Collaboration re-scoped 2026-07-03 (Ryan, via design interview): two features — (A) shared workspaces of up to 4 (owner + 3), and (B) per-note publishing via public link.** How multi-device sync, shared workspaces, note publishing, and the open-vs-paid model fit together._

> **2026-07-03 re-scope in one line.** The earlier "2-person pair sharing, both-pay" model (§2 below, locked 2026-07-02) is **superseded** by a **shared workspace of up to 4 people (the paying owner + a maximum of 3 invited members)** where the **owner's paid cloud+sync plan covers hosting/sync and each invited member brings their own AI key**, plus a **separate note-publishing feature** (public read-only links). Both were resolved through a structured grill; the decisions and their rationale are in [vision.md](vision.md) #16b and captured inline here.

## The model in one paragraph

There is **one fully open-source product** — apps, `packages/core`, **and the cloud backend** — in **a single public repo under AGPLv3**. Nothing is closed; there is no private backend repo. The app is fully functional **local-only** with no account (BYO-model AI, vault on disk); signing in connects it to our **hosted service** (sync, shared workspaces, managed cloud agent). The business is **hosting convenience, not secrecy**: anyone *may* self-host the whole stack, but almost everyone would rather pay ~$15/mo than run Postgres + edge functions + a sync worker. This is exactly how Cal.com, PostHog, and n8n operate. **AGPLv3 is the guardrail:** competitors can use and fork the code, but anyone running a *modified* hosted version must open their changes — which blocks a closed-source clone of our SaaS while keeping the project genuinely open.

_Why this over the earlier "closed hosted-only backend" plan: Ryan is unbothered by being copied and wanted one-repo simplicity; the Cal.com model delivers both. AGPL (not MIT) is deliberate — it costs nothing and stops a funded competitor from running a **closed** fork and never contributing back. Enterprise/`ee`-folder carve-out: **not now** — everything is open under one license; revisit an `/ee` commercial folder if/when teams features justify it (post-MVP)._

## 1. Sync across devices (single user)

Already locked in [architecture.md](architecture.md): canonical markdown store in Supabase, file-level versioning, git-style 3-way auto-merge, desktop mirrors to a real folder, mobile is a synced view. Nothing new here — restated because collaboration builds directly on it.

The key property: **the sync engine already assumes multiple concurrent writers per workspace** (laptop + phone + cloud agent). A second human is just another writer; the merge doesn't care who is typing.

## 2. Shared workspaces — up to 4 (owner + 3) — Feature A

The first collaboration feature, prioritized **ahead of Teams** (Ryan). A small group works on the **same** workspace at the same time. **Re-scoped 2026-07-03** from the earlier 2-person "pair sharing": a paying owner can share a workspace with **a maximum of 3 other people (4 total)**, and the entitlement model changed (below). Anything larger is org-scale — still Teams, still deferred.

### What's shared vs private
| Resource | Scope |
|---|---|
| `sources/`, `wiki/`, `notes/`, index, log | **Shared** — workspace-scoped |
| `cloud-ai-private` notes/folders | **Shared** to workspace members, but hidden from remote/cloud AI bodies |
| `local-only` notes/folders | **Not shared or synced**; existing cloud copies are removed on next sync |
| AI chats | **Private per member** (v1) — user-scoped, referencing the workspace |
| Change feed | Shared, **attributed per author** (member / member / agent) |
| Brain settings (agent instructions) | Shared (it's the workspace's brain) |

Shared chats are explicitly **not v1**; the chat model (user-scoped, workspace-referenced) leaves room to add per-chat sharing later without migration.

`cloud-ai-private` is not end-to-end encryption: the content still lives in the
workspace's canonical store so devices and members can sync it. The guarantee is
that KestraVault's remote AI prompts, retrieval, and agent mounts do not include
the body.

### Roles — owner + member only
Two roles, deliberately (avoids drifting into the Teams permission model):
- **Owner** — created/owns the workspace, holds the paid cloud+sync plan that funds its hosting/sync, manages membership (invite / remove), and can invite **at most 3 members** (hard cap; 4 people total).
- **Member** — equal read/write access to `sources/`, `wiki/`, `notes/`. No sub-roles, no per-zone permissions. If richer roles (admin/can-invite, view-only member) are ever needed, that is the Teams generalization (O6), not this feature.

### Entitlement — owner funds hosting/sync, members bring their own AI (revises the 2026-07-02 both-pay rule)
Resolved by grill 2026-07-03. **This supersedes the both-pay rule** for small-group sharing:
- **The owner needs an active paid cloud+sync plan** — the same subscription that gives them cloud sync across all their own devices. It covers the workspace's **hosting + sync** (Supabase storage, Realtime, the canonical store) for the whole group.
- **One plan covers up to 3 cloud vaults per owner (added 2026-07-03, Ryan):** the owner's plan covers **both their personal vaults and the shared ones — at most 3 cloud workspaces total**, enforced server-side at workspace creation (`workspaces_enforce_entitlement` trigger). Local-only vaults remain unlimited and free; self-hosted instances have no cap.
- **Members join free** — they need **only an account and their own AI key** (BYO-model). No per-member subscription. The account exists for auth/RLS; the key exists because **all AI in a shared workspace is member-BYO** (next section).
- **Consequence, accepted "for now":** the owner subsidizes the *sync/hosting* cost of up to 3 free members. That cost is small (markdown is tiny; no managed-agent spend is incurred by the company for shared workspaces — see below) and **bounded by the 3-member cap**. **Revisit** if abused — a per-seat hosting fee is the natural next lever, and Teams is the path to larger groups. Flagged as an open question.
- **The #16b unpaid-invitee read-only upgrade funnel largely dissolves here:** members are already free, so there is no "pay to participate" wall inside a shared workspace. (It still applies to *single-user* paid features and to Teams later.)
- **Lapsed owner →** the workspace drops to read-only for everyone until the owner re-subscribes; data is never locked away or deleted.

### AI in shared workspaces — client-side BYO-key only (the managed agent does not run here yet)
Resolved by grill 2026-07-03:
- Every member runs AI **on their own key, client-side** — the **portable/local agent loop** (the `preset.local` seam already in the desktop BYO-model settings), operating on the synced workspace files.
- **The hosted Managed Agent does not run for shared workspaces** in this phase. That is *why* the owner "only pays for hosting/sync" — the company incurs **no model spend** for shared-workspace AI; each member's key pays for their own runs. No shared credit pool, no cross-member metering.
- **Dependency:** this makes shared workspaces **depend on the portable BYO-key agent loop being built** (roadmap Post-MVP "local-only / self-host runtime"). Until that path is solid, shared-workspace AI is limited to whatever the client can run with the member's key.
- Consistent with vision #6 (managed agent is the default *single-user* brain) and #19 (BYO-key is the heavy/OSS/privacy path) — shared workspaces simply live on the BYO path for now.

### Concurrent edits — same file, same time (no CRDT; trivial at 4)
Grill 2026-07-03 confirmed: **keep the merge + presence model of vision #10**, unchanged, at this scale. No CRDT, no live co-editing. Three layers:
1. **3-way auto-merge** resolves non-overlapping edits — the common case; people mostly edit different files.
2. **Shrink the conflict window:** sync small and often; Supabase Realtime pushes changes within seconds.
3. **Presence:** show "«name» is editing this note" (Realtime broadcast) so people naturally avoid collisions — more than adequate for 4.

**True clash rule (N-way version of #10's "human hunk wins"): first-committer wins.** The first write to land on a hunk becomes canonical; a later conflicting edit is saved as a **`*.conflict.md` copy** and flagged in the UI — no silent overwrite, no data loss. (Deliberately **not** last-writer-wins, which would silently lose work and break the trust invariant.) **This promotes O8 (conflict UX) from edge-case polish to a required, ship-blocking design** — even 4 humans clash far more often than one human racing themself. CRDT stays rejected unless real simultaneous single-note editing proves common in the beta.

### Membership plumbing
- `workspace_members` table (owner / member roles), invite-by-link or email flow, Supabase **RLS scoped by membership** instead of by owner. **Enforce the 3-member cap** at invite time (RLS/trigger), not just in the UI.
- Removing a member revokes access going forward; their past contributions stay in the workspace history (attributed) — nothing is retroactively pulled.

### Teams — deferred (unchanged)
Company pays, members ride free, permissions/roles/presence at org scale — a different billing model and product surface. Stays Post-MVP (O6). Small-group sharing is deliberately shaped so Teams can generalize it (membership table + RLS + attribution already exist; Teams adds org billing + richer roles + a shared managed-agent credit pool).

## 3. Note publishing via public link — Feature B (designed now, built behind the web app)

The second, **separate** collaboration feature: **"share a specific note with people"** resolves to **publishing one note as a public, read-only web page** (Obsidian-Publish / Notion-public-page shaped) — *not* inviting a person into the workspace. Resolved by grill 2026-07-03.

- **Recipient:** anyone with the link, **no account required**, **read-only**. The link is the share.
- **Surface dependency (blocks the build):** a public link must render somewhere a browser can reach. There is **no web surface today** (only Electron desktop + RN mobile), and **O4 defers shipping a web app**. Decision: **design now, build when the web app / a minimal hosted render route exists** — i.e. sequence Feature B **after** O4 resolves. This does not reopen O4; it just declares the dependency.
- **Scope of shareable content: `notes/` only.** Human-owned notes. AI-owned `wiki/` pages and immutable `sources/` are **not** publishable (wiki changes under you; sources are often the most sensitive/copyrighted inputs).
- **No graph leak (load-bearing):** a published note's **`[[wikilinks]]` are flattened to plain display text** (no href, no resolution) so publishing one note can never expose the titles/existence/contents of private pages. Embedded images render via **per-asset public URLs** (Supabase Storage signed/public paths minted only for referenced assets).
- **Live, not snapshot:** the public page reflects the **current** note and auto-updates as the owner edits. (No draft/re-publish state in v1 — accepted trade-off: edits go public immediately, so "publish" is itself the intent signal. A snapshot/re-publish state can be added later if works-in-progress leaking proves a problem.)
- **AI stays out:** neither the owner's nor anyone's agent treats a published note specially; **shared notes are inert to AI unless explicitly opted into a brain** (and public recipients are anonymous — they have no agent). Interoperates with the existing per-note **Private** flag (which hides a note body from the *remote* agent): a note can be BYO-visible, publishable, and remote-AI-private independently.
- **Revocation:** publishing is **revocable** — unpublishing invalidates the link (and rotates any minted asset URLs). Default posture: **unlisted + `noindex`** (link-gated, not search-indexed); a "list publicly / allow indexing" toggle is a later refinement.

Publishing reuses almost none of Feature A's plumbing (no membership, no merge, no presence) — it is a **read path + a render route + per-note publish state**, gated on the web surface.

## 4. Open-core model: one repo, everything AGPLv3 (Cal.com-style)

### Repo layout
| Repo | Visibility | License | Contents |
|---|---|---|---|
| `kestravault` (this repo) | **Public at launch** | **AGPLv3** | *Everything:* `apps/desktop`, `apps/mobile`, `packages/core`, `supabase/` (schema/migrations/RLS/edge functions), sync coordination, workspace membership + invites, Stripe/billing/entitlements, managed-agent orchestration, website, surviving plan docs |

- **No repo split, no private backend.** The whole stack is public. The moat is **operational** (we host it well and cheaply for you), not code secrecy.
- The app is fully usable **local-only** with no account. Signing in adds the hosted sync/collab/agent. Self-hosting the backend is **allowed and supported by the license** — most users won't bother, which is the entire Cal.com bet.
- **AGPLv3** applies to all of it. A competitor may fork, but if they run a *modified* hosted version they must publish their modifications — no closed proprietary clone of our SaaS.
- **`/ee` commercial carve-out: not now.** Everything ships open under one license. Revisit a source-visible-but-commercially-licensed `/ee` folder (GitLab/Cal.com pattern) only if teams/enterprise features later justify it — that's post-MVP.

### License change required (MIT → AGPLv3) — pre-launch task
The repo currently ships **MIT** (root + `apps/desktop` `package.json`, `LICENSE`, README, CONTRIBUTING). Switching to AGPLv3 is a discrete task:
- **Dependency-license audit — DONE 2026-07-03.** Scanned all 632 installed packages: **100% permissive** (MIT/ISC/Apache-2.0/BSD/BlueOak/WTFPL/CC0/etc.), **zero copyleft**. Nothing blocks AGPL relicensing.
- **One flagged dependency:** `@anthropic-ai/claude-agent-sdk` is **proprietary** ("© Anthropic PBC. All rights reserved," per code.claude.com/docs legal terms), used only in [apps/desktop/src/main/ai.ts](../apps/desktop/src/main/ai.ts) for the Claude-subscription auth path. (The BYO-key path uses base `@anthropic-ai/sdk`, MIT.) This does **not** block AGPL (it's a dependency, not a copyleft license on our code), but it's a bundled proprietary component: treat it as a **separately-licensed third-party dependency** — keep it under Anthropic's terms, don't relicense it, and note the exception in a `NOTICE`/README line. Worth a lawyer's glance before launch given we distribute bundled Electron builds.
- Then swap: replace `LICENSE` with the full AGPLv3 text, update `license` fields in both `package.json`s to `"AGPL-3.0-only"`, and fix the license lines in README/CONTRIBUTING.
- Do this **before the public flip** (part of the launch checklist), not piecemeal now.

### Security posture (unchanged, still load-bearing)
Everything is public, so security must be **entirely** in the design, never in obscurity: RLS correctness, auth, encryption in transit/at rest, **zero secrets in code or history**. The pre-flip secret/history sweep in [launch-v1.md](launch-v1.md) now covers the *whole* codebase including backend — this matters more, not less, because the backend goes public too.

## Build order (when sync work starts)

**Feature A — shared workspaces (up to 4: owner + 3):**
1. Single-user multi-device sync (canonical store + merge engine + desktop mirror) — the already-planned Phase 0/1 work; nothing collab-specific. **BUILT 2026-07-03:** sync engine in `packages/core/src/sync/` (pull/push over the repos, 3-way merge, optimistic `commit_file_version` RPC, soft deletes, edits-beat-deletes), desktop loop in `apps/desktop/src/main/sync.ts` (launch + debounced local changes + Realtime + interval), Settings → “Sync & sharing” UI.
2. `workspace_members` (owner/member) + RLS-by-membership + invite-by-link/email flow + **3-member cap enforced server-side**. **BUILT 2026-07-03** (membership migration + desktop invite/join/remove UI).
3. Owner-funds-hosting entitlement check (owner has active paid plan → workspace may add free members); members join with account + own key. No per-member Stripe check. **BUILT 2026-07-03:** `user_entitlements` + `instance_config(self_hosted)` migration — plan-gated workspace creation, **3-cloud-vault cap per owner**, plan-gated sharing, lapsed owner → read-only via RLS; Stripe `billing-webhook` edge function written (deploy blocked on Stripe account — NEEDS-RYAN.md).
4. Client-side BYO-key agent path for members (depends on the portable/local agent loop). **Already satisfied on desktop:** every member's AI runs through their own key / Claude login (`apps/desktop/src/main/ai.ts`); sync never touches model traffic.
5. Presence + per-author attribution in the change feed. **Attribution recorded** (`author_id` on `file_versions`/`change_sets`, stamped by the sync engine); presence + feed UI still open.
6. Conflict UX (O8) — **first-committer-wins + `*.conflict.md`** — designed before shared workspaces ship, not after. **Engine behavior built + tested** (loser saved as a synced `*.conflict.md` copy, surfaced in Settings); a richer merge UI still open.

**Feature B — note publishing (public link):** sequenced **after** the web app / a minimal hosted render route (O4). Then: per-note publish state + revocation → read-only render route → `[[wikilink]]` flattening + per-asset public URLs → unlisted/`noindex` default.

Feature A lands **after** MVP billing + sync, as the first Post-MVP collaboration priority — before Teams. Feature B follows the web surface. All of it lives in this one repo.
