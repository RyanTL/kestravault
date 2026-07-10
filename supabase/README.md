# supabase/

Local Supabase stack for KestraVault — the **canonical markdown store** (Postgres +
auth + storage + realtime). Schema follows `plan/data-model.md` ("Server
canonical schema" is authoritative).

## Layout

```
supabase/
  config.toml                          # local stack config (project_id = kestravault)
  migrations/
    20260627000000_init_canonical_store.sql     # canonical tables, enums, owner RLS
    20260629000000_zone_enforcement.sql         # three-zone permissions + integrity guards
    20260703000000_workspace_members.sql        # shared workspaces: members, invites, RLS-by-membership, 3-member cap
    20260703093000_note_publishing.sql          # per-note publish state + anonymous token-gated read (Feature B)
    20260703150000_sync_commit_attribution.sql  # commit_file_version RPC (optimistic sync commits) + author_id attribution
    20260703160000_entitlements.sql             # paid-plan gates: 3-vault cap, sharing gate, lapsed→read-only, self_hosted bypass
    20260709120000_privacy_rules.sql            # path privacy metadata: public vs cloud-ai-private
  functions/
    deno.json                          # Deno import map (no npm deps)
    _shared/cors.ts                    # CORS helper
    ingest/
      index.ts                         # ingest loop handler (Managed Agents call stubbed)
      types.ts                         # typed request/response + agent contract
    billing-webhook/
      index.ts                         # Stripe webhook -> user_entitlements (the only entitlement writer)
```

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase --version`)
- Docker running locally

## Run it

From the repo root (or anywhere — the CLI finds `supabase/`):

```bash
# Start the local stack (Postgres, auth, storage, realtime, Studio).
# On first start it applies everything in migrations/ automatically.
supabase start

# Re-apply from scratch on a clean database (drops + recreates + re-migrates).
supabase db reset
```

`supabase start` prints local URLs and keys (API URL, anon/service keys, Studio
at http://localhost:54323). Open Studio to browse the tables.

Stop / clean up:

```bash
supabase stop          # stop containers (keeps data)
supabase stop --no-backup   # stop and wipe local data
```

## What the migrations create

### `20260627000000_init_canonical_store.sql` — canonical store

- **Tables:** `workspaces`, `files`, `file_versions`, `change_sets`,
  `file_changes`, `assets` — matching `plan/data-model.md` column-for-column.
- **Enums:** `zone`, `file_type`, `updated_by`, `change_set_kind`, `file_op`.
- **IDs:** ULID-compatible `text` (app-generated), consistent with
  `packages/core/src/types/ids.ts`. `owner_id` is a `uuid` → `auth.users`.
- **RLS:** every table is owner-scoped via `owner_id` — a user sees only their
  own workspace's rows and all descendants.
- **Realtime:** enabled on `files` and `change_sets` (inserts/updates are
  broadcast to clients; RLS still applies to the stream).

### `20260629000000_zone_enforcement.sql` — three-zone permissions + integrity

Adds the **enforcement layer** for the zone matrix in `plan/data-model.md`
("The three zones & enforced permissions") plus integrity guards. No new tables
or columns — only triggers/functions on the existing schema.

- `enforce_agent_zone_permissions()` (BEFORE INSERT/UPDATE on `files`) — encodes
  the agent's per-zone write permissions (see [Zones & enforcement](#zones--enforcement)).
- `files_guard_version_and_touch()` (BEFORE UPDATE on `files`) — versions are
  monotonic (never regress) and `updated_at` is stamped on every change.
- `block_file_version_mutation()` (BEFORE UPDATE on `file_versions`) — history is
  append-only; a written version is immutable (rows still cascade-delete).

### `20260709120000_privacy_rules.sql` — path privacy metadata

Adds `privacy_rules`, a workspace-scoped table for note/folder privacy rules
that are safe to sync:

- `public` — synced normally; remote AI may read content.
- `cloud-ai-private` — synced and workspace-visible, but remote AI/orchestrator
  paths may only use title/path plus description/tags metadata.

`local-only` is intentionally absent from Postgres. Those rules stay in the
desktop/mobile local privacy store and cause matching cloud files/assets to be
soft-deleted on sync rather than uploaded. `cloud-ai-private` is an AI
access-control guarantee, not end-to-end encryption from the database operator.

## Zones & enforcement

Each workspace is a tree of three zones plus agent-maintained root files. RLS
keeps users out of _each other's_ rows; the zone triggers enforce _who may write
what within a workspace_ — they fire for every writer, including the service role
the cloud agent runs under (the agent's read-only container mounts are the
primary guard; the triggers are defense in depth).

| Zone / file                                      | Human                       | Agent                    | Enforced by                                     |
| ------------------------------------------------ | --------------------------- | ------------------------ | ----------------------------------------------- |
| `sources/`                                       | create / delete (immutable) | **read-only**            | trigger: agent writes rejected                  |
| `wiki/`                                          | read / write                | **read / write**         | (allowed)                                       |
| `notes/`                                         | read / write                | **read-only by default** | trigger: agent writes rejected unless approved¹ |
| `index.md`, `log.md` (`type` index/log)          | rarely                      | read / write             | (allowed)                                       |
| `.kestravault/instructions.md` (`type` instructions) | via Brain settings          | **read-only at runtime** | trigger: agent writes rejected                  |

¹ The "agent may write `notes/` when the user explicitly asks" exception is
granted per-transaction by the orchestrator immediately before the write:

```sql
select set_config('kestravault.allow_agent_notes_write', 'on', true);  -- txn-local
```

> **Note on "one workspace per user":** RLS scopes every row to its owner, so a
> user only ever sees their own workspace's data. We do **not** add a hard
> 1-workspace-per-owner constraint — `plan/data-model.md` treats workspaces as
> isolated _brains_ a user may have several of (vision #5). Tighten with a unique
> index on `workspaces(owner_id)` if a strict 1:1 is ever desired.

## History & undo

Undo is built on the canonical tables (no extra machinery needed):

- Every agent run is one atomic `change_sets` row (`kind`, `summary`,
  `source_event`) with its `file_changes` (`op`, `before_version`,
  `after_version`, `diff`) — this backs the **change feed**.
- **One-tap undo** = apply the inverse `file_changes` (restore each file to
  `before_version`, bumping `version` forward) and set `reverted = true` on the
  original change-set. `file_versions` makes the restore exact.

## Edge functions

### `ingest` — the ingest loop (`plan/agent-loop.md`)

`POST /functions/v1/ingest` — _source in → wiki page + index/cross-refs + log
entry out_. The handler implements steps 1–6 of the ingest loop; the **Managed
Agents call (step 4) is the only stub** (`runMaintainerAgent`, with TODOs). The
surrounding contract — idempotency (source id + content hash), file mounting
(sources RO, wiki RW, index/log RW, instructions RO), change-set build/apply — is
laid out around it.

```jsonc
// request
{ "workspaceId": "01J…", "sourceId": "01J…",
  "mode": "default",        // light | default | deep  (Haiku | Sonnet | Opus)
  "ingestMode": "async",    // async | realtime
  "idempotencyKey": "…" }   // optional; defaults to sourceId:contentHash
// response
{ "status": "ingested",     // ingested | skipped | failed
  "changeSetId": "01J…",
  "touched": [{ "path": "wiki/concepts/ownership.md", "op": "update",
                "beforeVersion": 3, "afterVersion": 4, "zone": "wiki",
                "fileId": "01J…" }],
  "summary": "Ingested 'Intro to Rust ownership' — touched 2 page(s)",
  "logLine": "## [2026-06-29] ingest | Intro to Rust ownership" }
```

Run/serve locally with `supabase functions serve ingest` (needs the local stack).

## After changing the schema

> ⚠️ Migrations are **serialized** — add new changes as a _new_ numbered
> migration; do not edit the initial one once it has shipped.

The TypeScript types in `packages/core` are owned by that package. After this
migration merges (or any schema change), regenerate them there:

```bash
supabase gen types typescript --local > <core's types target>
```

(Run from `packages/core` per that package's conventions — this directory does
not generate types.)

## Self-hosting (open core)

The entire backend in this folder is what the hosted KestraVault Cloud runs — you
can run it yourself (AGPLv3). Bring up a Supabase project (hosted or your own
stack), apply the migrations, then bypass billing on your instance once:

```sql
update public.instance_config set self_hosted = true;
```

With `self_hosted = true` every entitlement check passes: no paid plan, no
vault cap, sharing enabled. Point the desktop app at your instance in
**Settings → Sync & sharing → Self-hosted** (project URL + anon key). The
`billing-webhook` function is simply never deployed on a self-hosted instance.
