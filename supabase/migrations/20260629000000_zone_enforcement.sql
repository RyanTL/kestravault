-- KestraVault — three-zone permission enforcement + integrity guards
--
-- Builds on 20260627000000_init_canonical_store.sql. That migration created the
-- canonical tables (workspaces, files, file_versions, change_sets, file_changes,
-- assets), the enums, and owner-scoped Row-Level Security.
--
-- What RLS already does: every row is scoped to the owning user, so a user can
-- only ever see/modify their own workspace's rows (one workspace tree per owner;
-- the agent never crosses workspaces — vision #5).
--
-- What RLS CANNOT do, and why this migration exists: the cloud "maintainer"
-- agent (and the ingest orchestrator) run server-side under the service role,
-- which *bypasses* RLS. So RLS protects users from each other, but it does not
-- encode the per-zone permission matrix from plan/data-model.md
-- ("The three zones & enforced permissions"). That matrix is enforced here with
-- triggers that fire for EVERY writer, service role included (defense in depth;
-- the primary enforcement is still the agent's read-only container mounts, per
-- plan/agent-loop.md "Safety, permissions & reliability").
--
-- Permission matrix encoded below (Agent column):
--   sources/      read-only   — immutable raw inputs; the agent has no write path
--   wiki/         read/write  — the agent's work area
--   notes/        read-only by default; writable only on explicit user approval
--   index / log   read/write  — agent-maintained catalog + activity log
--   instructions  read-only at runtime — schema edits are a human action
--
-- Zones map to the `zone` enum ('sources','wiki','notes'); index.md, log.md and
-- .kestravault/instructions.md are identified by `type` ('index','log','instructions'),
-- consistent with packages/core/src/types/enums.ts (no separate "meta" zone).
--
-- Not applied against a live project (Docker unavailable at authoring time);
-- migration is self-contained, ordered after the init migration, and re-run-safe
-- (create-or-replace functions; drop-if-exists before each trigger).

begin;

-- ---------------------------------------------------------------------------
-- 1. Agent zone permissions (the three-zone matrix).
--    Only `updated_by = 'agent'` writes are constrained here; human/orchestrator
--    writes remain governed by RLS + application logic (e.g. flipping a source's
--    status pending -> ingested is a system/human write, not an agent write).
-- ---------------------------------------------------------------------------

create or replace function public.enforce_agent_zone_permissions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only the agent is constrained; everyone else passes through.
  if new.updated_by <> 'agent' then
    return new;
  end if;

  -- index.md / log.md are agent-maintained (read/write) wherever they sit.
  if new.type in ('index', 'log') then
    return new;
  end if;

  -- sources/ are immutable raw inputs — the agent has no write path.
  if new.zone = 'sources' then
    raise exception
      'zone violation: the agent cannot write to sources/ (immutable raw inputs) [%]',
      new.path
      using errcode = 'check_violation';
  end if;

  -- instructions.md is the agent's own schema — read-only at runtime; schema
  -- changes are a human action via Brain settings (the agent may *propose* them).
  if new.type = 'instructions' then
    raise exception
      'zone violation: instructions.md is read-only to the agent at runtime [%]',
      new.path
      using errcode = 'check_violation';
  end if;

  -- notes/ is human-owned. The agent may write only when the user explicitly
  -- asks ("organize this", "make this a wiki page"). The orchestrator grants
  -- that approval per-transaction immediately before the write, e.g.:
  --   select set_config('kestravault.allow_agent_notes_write', 'on', true);
  -- The flag is transaction-local (the `true` arg) so it never leaks to the
  -- next statement/connection.
  if new.zone = 'notes'
     and coalesce(current_setting('kestravault.allow_agent_notes_write', true), 'off') <> 'on' then
    raise exception
      'zone violation: notes/ is human-owned; agent writes require explicit user approval [%]',
      new.path
      using errcode = 'check_violation';
  end if;

  -- Remaining cases — wiki/, and type index/log — are agent read/write. Allowed.
  return new;
end;
$$;

drop trigger if exists files_enforce_agent_zone_permissions on public.files;
create trigger files_enforce_agent_zone_permissions
  before insert or update on public.files
  for each row execute function public.enforce_agent_zone_permissions();

-- ---------------------------------------------------------------------------
-- 2. files integrity: monotonic versions + honest updated_at.
--    Versions back the file-level 3-way merge and undo, so they must never move
--    backwards; updated_at is stamped on every modification.
-- ---------------------------------------------------------------------------

create or replace function public.files_guard_version_and_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version < old.version then
    raise exception
      'version regression on file % (% -> %); versions are monotonic',
      old.id, old.version, new.version
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists files_guard_version_and_touch on public.files;
create trigger files_guard_version_and_touch
  before update on public.files
  for each row execute function public.files_guard_version_and_touch();

-- ---------------------------------------------------------------------------
-- 3. file_versions is append-only history.
--    A historical version is immutable once written; new versions are appended,
--    never edited in place (rows still cascade-delete with their parent file).
-- ---------------------------------------------------------------------------

create or replace function public.block_file_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'file_versions is append-only; version % of file % cannot be modified',
    old.version, old.file_id
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists file_versions_block_update on public.file_versions;
create trigger file_versions_block_update
  before update on public.file_versions
  for each row execute function public.block_file_version_mutation();

commit;
