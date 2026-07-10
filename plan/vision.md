# Vision & Decision Log

_Locked 2026-06-27 through a structured design interview. Each decision lists the choice and the one-line rationale. Items marked **[Ryan's call]** are where the human overrode or reshaped the default recommendation._

## North star
An AI-first second brain that feels like magic to a mainstream user and like power to a technical one — **the same app**, with depth revealed only on demand.

> **Guiding principle — "Magic by default, depth on demand."**
> The default experience is pure magic: the wiki maintains itself, the machinery is hidden. Every magic action is inspectable and overridable: see exactly what the AI changed, edit the agent's instructions, drop to the raw markdown, bring your own model. Mainstream users never open the trapdoor; technical users live down there. One app, one axis of disclosure — the way Linear, Arc, and Raycast served both audiences without building two products.

## The three layers (from Karpathy's pattern)
1. **Raw sources** — your curated, immutable source documents. The AI reads, never edits.
2. **The wiki** — LLM-generated, interlinked markdown the agent owns and continuously maintains.
3. **The schema / instructions** — how the wiki is structured and how the agent behaves. Co-evolved with the user, hidden from the main UI.

---

## Decision log

### Positioning & audience
| # | Decision | Rationale |
|---|---|---|
| 1 | Serve **mainstream + technical together**, magic-forward. Teams later (not a near-term priority). **[Ryan's call]** | The value is only understood by power users today, but the convenience buyers are mainstream — progressive disclosure lets one app serve both. |
| 2 | **Engine stays general** across use cases (personal, research, business, learning). **[Ryan's call — declined to pick one hero use case]** | Ryan wants it good at everything. _Open risk:_ a launch still benefits from one polished hero demo — flagged for the marketing/launch decision, not architecture. See [open-questions.md](open-questions.md). |

### Data model
| # | Decision | Rationale |
|---|---|---|
| 3 | **Markdown files are the source of truth.** | The only model where Karpathy's pattern + open-source + local + git all work; the real differentiator vs Notion. |
| 4 | **Three zones:** **Sources** (you drop, immutable) · **Wiki** (AI owns & maintains) · **Notes** (you own; AI reads, edits only if asked). | Clear ownership = clear trust + a real home for old-fashioned manual notes. |
| 5 | **Workspaces = separate brains;** the AI never mixes them. | Matches the personal-vs-business split; clean privacy boundary. |

### The agent
| # | Decision | Rationale |
|---|---|---|
| 6 | **Cloud-hosted agent**, full parity on every client (incl. mobile). Local/BYO-model path comes later. | Makes mobile + "just works" + billing real now; the brain lives in the cloud so the phone isn't doing heavy lifting. |
| 7 | **Auto-ingest on drop → reviewable change feed + one-tap undo.** Power users can switch to "ask first." | Magic by default, trust through transparency. |
| 8 | **Tiered models:** Haiku for grunt bookkeeping (filing, cross-refs, summaries, log); Sonnet/Opus for synthesis, hard queries, contradiction-spotting. | Single biggest cost lever — ~3–5× cheaper with little visible quality loss. |
| 9 | **Async ingestion by default** (Batch API, 50% off + better caching); **real-time on demand** when actively watching. | Lowest cost; matches the "drop it and the wiki updates" mental model. |
| 10 | **Conflict model: AI proposes changes as a reviewable diff; your in-place edits always win.** No live human↔AI co-edit in v1. | Sidesteps almost all data-loss; consistent with the change-feed trust model. |
| 11 | **Agent instructions** (the CLAUDE.md-equivalent) live in a hidden **"Brain settings"** panel, edited in plain language with the AI's help. | Exactly the "hide instructions from the main UI but keep them customizable" goal, via progressive disclosure. |

### UX
| # | Decision | Rationale |
|---|---|---|
| 12 | **Wiki/notes is the primary surface; the AI is an ever-present panel/bar.** Mobile = wiki + AI bar. | Familiar (Notion/Obsidian), lowest learning curve, identical on mobile. |
| 13 | **Manual notes are fully usable without AI;** AI is optional per note. | Core requirement — old-fashioned note-taking must work standalone. |
| 14 | **Onboarding: pick your intent → AI scaffolds the zones + tailored instructions → refine by chat.** | Magic-first but personalized; doubles as teaching the core loop. |
| 15 | **Design:** dark-first (black/white + shades), light mode (white/black), minimal. Notion + Obsidian as visual inspirations, with a distinct identity. | Per Ryan's stated aesthetic. |

### Business model
| # | Decision | Rationale |
|---|---|---|
| 16 | **Open-core license — REVISED 2026-07-03 to full Cal.com model:** **one public repo, everything (apps + `core` + `supabase/` backend + billing) under AGPLv3.** No closed backend, no repo split. Moat = **hosting convenience, not secrecy**; AGPL blocks closed-source SaaS clones. (Supersedes both the original MIT-apps/AGPL-backend split *and* the 2026-07-02 "closed hosted-only backend" turn. **Superseded in turn 2026-07-09: relicensed AGPLv3 → MIT post-launch — Ryan chose maximum openness over the copyleft guardrail.**) See [sync-collab-open-core.md](sync-collab-open-core.md). | Ryan doesn't mind being copied and wanted one-repo simplicity; Cal.com/PostHog/n8n prove fully-open + hosted-service works. AGPL (not MIT) stops a funded competitor running a closed fork without contributing back. `/ee` commercial carve-out deferred. **Requires MIT→AGPLv3 relicense before launch (dep-license audit first).** |
| 16b | **Collaboration re-scoped 2026-07-03 (supersedes the 2026-07-02 both-pay pair-sharing).** Two features before Teams: **(A) shared workspaces of up to 4 (paying owner + a max of 3 invited members)** — **owner's paid cloud+sync plan funds hosting/sync; each invited member joins free with an account + their own AI key**; owner/member roles only; all AI is member-BYO client-side (managed agent doesn't run for shared workspaces); first-committer-wins clash → `*.conflict.md`; chats private per member; attributed change feed; no CRDT. **(B) note publishing** — publish a single `notes/` file as a public read-only link (`[[links]]` flattened to plain text = no graph leak; live; anonymous; AI stays out), **sequenced behind the web app (O4)**. Larger groups = **Teams** (~$50, company pays), still deferred. | A 4-person cap is the highest-value collab slice and rides the existing multi-writer sync engine; pushing AI cost onto member keys lets the owner pay only hosting, keeping the company's model spend at zero for shared workspaces, and the 3-member cap bounds the subsidy. Note publishing is a separate read-path/publish feature, not workspace membership. Details + rationale in [sync-collab-open-core.md](sync-collab-open-core.md). |
| 17 | **Free tier = metered credits on capable models** (e.g. ~20 ingests + ~100 queries/mo, tunable); **manual notes always free & unlimited.** | Predictable cost; the free experience is genuinely good, just limited. Mirrors Tana/Notion. |
| 18 | **Paid ~$15/mo = generous managed quota + BYO-key escape** for effectively unlimited/heavy/private use. Add-on credits for overage. Teams ~$50 later. | Caps the company's downside, keeps magic-first for normal users, serves heavy + OSS users natively. |
| 19 | **BYO-key + local models + self-host = the privacy / heavy-user / open-source path.** | Moves heavy-user cost off our books and is on-brand. |

### Privacy & security
| # | Decision | Rationale |
|---|---|---|
| 20 | **Encrypted in transit & at rest; the cloud agent reads plaintext** (it must, to maintain the wiki). Workspaces are private from other users but **not zero-knowledge** from the service. | Honest and buildable. True-privacy users go BYO-key + local model + self-host. Full E2E is incompatible with a managed agent. |

---

## Unit economics (reference)
Model pricing (per 1M tokens, as of 2026-06): **Opus 4.8** $5 / $25 · **Sonnet 4.6** $3 / $15 · **Haiku 4.5** $1 / $5. Prompt caching ≈ 10% of input cost on repeated context; Batch API = 50% off.

Rough cost **with caching**: one **ingest** ≈ $0.15 (Haiku) / $0.50 (Sonnet) / $0.75 (Opus); one **query** ≈ $0.02 / $0.07 / $0.12.

**Key finding:** a flat $15 plan with *unlimited* agentic AI loses money on all but the lightest users (a "medium" user ≈ $75/mo of raw model cost on Sonnet). This is an *unlimited* problem, not a price problem — every competitor meters. Hence: metered free tier + quota + BYO-key escape + tiered models + async/batch ingestion.

## Competitive anchors (2026)
Notion (Free / Plus $10 / Business $20 — full AI now in Business, standalone add-on killed) · Mem $14.99 · Reflect $10 (E2E) · Tana (Free / Plus $10 / Pro $18, sells "AI credits") · Obsidian (app free, paid Sync/Publish). Nobody offers unlimited agentic AI at a flat rate.
