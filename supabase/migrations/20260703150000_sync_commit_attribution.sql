-- KestraVault — sync commit path + per-author attribution
--
-- Two things the multi-device / shared-workspace sync engine
-- (packages/core/src/sync/engine.ts) needs from the server:
--
--   1. author_id on file_versions and change_sets — per-author attribution in
--      shared workspaces (plan/sync-collab-open-core.md §2 "Change feed …
--      attributed per author"). Nullable: agent/system writes and rows that
--      predate attribution have no author.
--
--   2. commit_file_version(...) — the engine's ONLY write path. It performs an
--      optimistic-concurrency commit as one transaction: verify the stored
--      version still equals p_expected_version (this is how "first committer
--      wins" is decided), write the new state of `files`, and append the
--      immutable `file_versions` row. A losing writer gets a 'version_conflict'
--      error (never a silent overwrite) and re-merges client-side.
--
-- SECURITY INVOKER on purpose: RLS applies, so only workspace members can
-- commit, and the zone/version triggers from earlier migrations still fire.
--
-- Not applied against a live project (Docker unavailable at authoring time);
-- self-contained, ordered after the note_publishing migration, re-run-safe.

begin;

-- ---------------------------------------------------------------------------
-- 1. Attribution columns
-- ---------------------------------------------------------------------------

alter table public.file_versions
  add column if not exists author_id uuid references auth.users (id) on delete set null;

alter table public.change_sets
  add column if not exists author_id uuid references auth.users (id) on delete set null;

create index if not exists file_versions_author_id_idx on public.file_versions (author_id);
create index if not exists change_sets_author_id_idx   on public.change_sets (author_id);

-- ---------------------------------------------------------------------------
-- 2. The atomic optimistic commit
-- ---------------------------------------------------------------------------

create or replace function public.commit_file_version(
  p_file_id          text,
  p_workspace_id     text,
  p_path             text,
  p_zone             public.zone,
  p_type             public.file_type,
  p_title            text,
  p_content          text,
  p_sha256           text,
  p_expected_version integer,
  p_updated_by       public.updated_by,
  p_deleted          boolean,
  p_version_id       text,
  p_author_id        uuid,
  p_change_set_id    text
) returns public.files
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version integer;
  new_version     integer;
  result          public.files;
begin
  -- Lock the file row (if it exists) so concurrent commits serialize and the
  -- version check below cannot race.
  select f.version into current_version
  from public.files f
  where f.id = p_file_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      raise exception
        'version_conflict: file % does not exist (expected version %)',
        p_file_id, p_expected_version
        using errcode = 'serialization_failure';
    end if;
    new_version := 1;
    -- The partial unique index files_workspace_path_idx rejects a create that
    -- races another live file onto the same path; the client maps that unique
    -- violation to a conflict result too.
    insert into public.files
      (id, workspace_id, path, zone, type, title, content, sha256, version,
       updated_by, deleted)
    values
      (p_file_id, p_workspace_id, p_path, p_zone, p_type, p_title, p_content,
       p_sha256, new_version, p_updated_by, p_deleted)
    returning * into result;
  else
    if current_version <> p_expected_version then
      raise exception
        'version_conflict: file % is at version %, commit expected %',
        p_file_id, current_version, p_expected_version
        using errcode = 'serialization_failure';
    end if;
    new_version := p_expected_version + 1;
    update public.files
    set path       = p_path,
        zone       = p_zone,
        type       = p_type,
        title      = p_title,
        content    = p_content,
        sha256     = p_sha256,
        version    = new_version,
        updated_by = p_updated_by,
        deleted    = p_deleted
    where id = p_file_id
    returning * into result;
  end if;

  insert into public.file_versions
    (id, file_id, version, content, sha256, updated_by, author_id, change_set_id)
  values
    (p_version_id, p_file_id, new_version, p_content, p_sha256, p_updated_by,
     p_author_id, p_change_set_id);

  return result;
end;
$$;

-- Members commit through their session; the orchestrator uses the service role.
revoke all on function public.commit_file_version(
  text, text, text, public.zone, public.file_type, text, text, text, integer,
  public.updated_by, boolean, text, uuid, text
) from public;
grant execute on function public.commit_file_version(
  text, text, text, public.zone, public.file_type, text, text, text, integer,
  public.updated_by, boolean, text, uuid, text
) to authenticated, service_role;

commit;
