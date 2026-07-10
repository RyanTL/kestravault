# Agent Loop

_How the cloud agent actually does Ingest and Query, on Anthropic Managed Agents. Implements vision #6–10 and resolves the v1 approach for open question O7._

## Where each operation runs (and why)
| Operation | Runtime | Why |
|---|---|---|
| **Ingest** (writes files) | **Managed Agents session** (per-session container with `bash/read/write/edit/grep`) | It needs to read the source, grep/read the wiki, and **edit many files** — the Claude Code environment as a service. |
| **Query** (reads only) | **Direct Claude API call** (no container) | Answering doesn't write files. Retrieve relevant pages server-side, pass them as context — cheaper and faster than spinning a container per question. |

This split is the core cost/latency optimization: containers only when we're writing.

## Managed Agents setup (create once, run per-op)
- **One persisted Agent** for ingest, the `maintainer`, created at setup and referenced by ID (never re-created per run). Its `system` prompt = our base wiki-maintainer rules; tools = `agent_toolset_20260401`.
- The per-workspace **`instructions.md` schema is injected per session** (in the kickoff message / a `system.message`), so each run uses the current schema without versioning a new agent.
- **Environment:** cloud, `limited` networking (no egress needed for v1 paste capture; allow web-fetch only when URL ingestion lands).
- Per operation: create a **Session** → mount the workspace files as resources → stream events → on idle, collect outputs.

## Ingest loop (step by step)
Trigger: user drops a source (v1 = paste). The orchestrator (TypeScript) saves it to `sources/s-<date>-<slug>.md` (status `pending`) and enqueues a job. **Async by default** (Batch-eligible); **real-time** when the user is actively watching.

```
 user drops source
        │
        ▼
 1. save to sources/  ──►  2. create MA session, mount files:
                              sources/<new>     (read-only)
                              wiki/**           (read-write)
                              index.md, log.md  (read-write)
                              .kestravault/instructions.md (read-only)
                              + snapshot mounted file hashes
        │
        ▼
 3. kickoff message → agent runs in container:
      read source → grep/read relevant wiki pages →
      create/extend entity/concept/topic pages →
      add [[cross-references]] → flag contradictions →
      update index.md → append one line to log.md
      (stream events → live progress UI when real-time)
        │
        ▼
 4. on session idle → read back wiki/, index.md, log.md
      → diff vs snapshot → build atomic CHANGE-SET
        │
        ▼
 5. apply to canonical (new versions, updated_by=agent),
    record change_set + file_changes, mark source `ingested`
        │
        ▼
 6. Realtime push → desktop writes folder mirror, mobile refreshes
    → change feed shows "Ingested 'X' — touched N pages" + diffs + UNDO
```

**Kickoff instruction (shape):** "A new source was added at `<path>`. Read it and update the wiki per the schema below. Create or extend the relevant entity/concept/topic pages, maintain `[[cross-references]]`, note where it contradicts existing claims, update `index.md`, and append one line to `log.md`. Work only in `wiki/`, `index.md`, and `log.md`. End with a short summary of what you changed. \n\n<schema = instructions.md>".

**Privacy filtering:** before a remote/cloud agent session starts, the mounted
workspace is filtered to exclude `cloud-ai-private` and `local-only` paths. The
agent cannot `Read`, `Grep`, `Glob`, or write into those paths; attempts are
denied by the tool guard. Local/on-device providers may read private content
because nothing leaves the device.

**Edge cases:** agent tries to touch `notes/` or `sources/` → blocked by mount perms; agent tries to touch private paths → blocked by the filtered mount + tool guard; concurrent human edit → 3-way merge on apply, human hunk wins; error/timeout → job retried, partial changes discarded (apply only on clean completion); duplicate drop → idempotency key = source `id` + content hash.

## Query loop (step by step)
Trigger: user asks a question in the AI panel (scoped to the current workspace).
1. **Retrieve (index-first).** Read `index.md` (cheap, cached) → select candidate pages. v1 selection = a Haiku pass over the index + keyword/heading match (no embeddings yet — O9). Fetch those pages from Postgres.
2. **Answer.** Pass the selected pages to the answering model; stream a synthesized answer **with citations** (links to the wiki pages + originating sources).
3. **File-back (optional).** "Save this answer" → create a wiki page (or a note) from it, run through the **same change-set / change-feed machinery** so explorations compound just like ingests (Karpathy's "answers become pages").

No container is spun for queries — pure read + synthesize.

## Model routing (the "tiered models" decision, made concrete)
| Task | Model | Notes |
|---|---|---|
| Ingest (write wiki) | **Sonnet 4.6** default · **Opus 4.8** "deep" mode · **Haiku 4.5** "light" mode | Quality matters for the wiki; default mid-tier, let the user/heuristics escalate or downgrade per source importance. |
| Query answer | **Sonnet 4.6** · **Opus 4.8** "deep" | |
| Retrieval / page-selection | **Haiku 4.5** | Cheap pass over `index.md`. |
| Titles, slugs, log lines, summaries | **Haiku 4.5** | Done as direct non-agentic calls, off the container path. |
| Embeddings / vector search | TBD (Post-MVP, O9) | When `index.md` stops scaling. |

Mid-loop model switching isn't possible inside one Managed Agents session (an agent has one model), so tiering is applied **across** operations (cheap helpers run as separate direct calls) and **per-run mode** (light/default/deep selects the agent/model), not within a single agentic loop.

## Cost & async controls
- **Async + Batch:** default ingest is queued; batch-eligible model calls use the **Batch API (50% off)**. Real-time mode (user watching) streams live instead.
- **Prompt caching:** stable system prompt + `instructions.md` are cached; the wiki context is cached within a session. Keeps the agentic re-reads at ~10% input cost.
- **Quota metering:** the orchestrator counts tokens per job and debits the user's credits (free tier limits / paid quota; BYO-key bypasses our meter). See [vision.md](vision.md) economics.

## Safety, permissions & reliability
- **Confinement:** agent works only in `wiki/` + `index.md` + `log.md`; `sources/` mounted read-only; `notes/` untouched unless user-invoked; `instructions.md` read-only at runtime (schema edits are a human action in Brain settings).
- **Atomicity:** changes apply only on clean completion as one change-set; partials discarded.
- **Undo:** revert the change-set (versions make this exact).
- **Idempotency:** ingest keyed to source id + content hash.
- **Ingest authorization:** the `ingest` edge function runs with the service role (bypasses RLS), so it authorizes callers itself (`supabase/functions/ingest/auth.ts`): the server orchestrator presents the shared secret `INGEST_SECRET` (`x-ingest-secret` header), or a desktop/mobile client presents the signed-in user's JWT and must be a member of the target workspace. Everything else is refused before any work runs — without this, any authenticated user could ingest into another user's workspace.
- **Beta risk:** Managed Agents is beta — keep the **portable agent loop** (Claude API + our own sandbox, any provider) viable as the fallback and as the self-host/BYO-model path. See open-questions O7.

## What still needs build-time validation (O7)
The mount → edit → diff-back → change-set flow (steps 2/4/5 above) is the riskiest integration. Validate early with a hello-world ingest: drop one paste source, confirm the agent edits land back as a clean change-set with a correct diff and a working undo.
