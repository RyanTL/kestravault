-- KestraVault — member directory + attributed change feed
--
-- Two read paths the shared-workspace UI needs (NEEDS-RYAN.md §6 "known gaps"):
--
--   1. workspace_member_directory(ws_id) — resolve member user ids to emails.
--      Clients cannot read auth.users under RLS, so the members list showed
--      truncated ids. SECURITY DEFINER with an explicit caller-membership
--      check: you only see emails of people in a workspace you belong to.
--
--   2. workspace_change_feed(ws_id, max_rows) — the attributed change feed
--      (plan/sync-collab-open-core.md §2 "attributed change feed"). One row
--      per committed file version, newest first, joined with the file's
--      path/title and the author's email. Same membership gate.
--
-- Both functions are read-only, STABLE, and never expose anything about
-- workspaces the caller is not a member of (they return zero rows instead of
-- erroring, so a stale client after removal degrades quietly).
--
-- Not applied against a live project at authoring time; self-contained,
-- ordered after the entitlements migration, re-run-safe (create or replace).

begin;

-- ---------------------------------------------------------------------------
-- 1. Member directory: user id -> email for one workspace's members.
-- ---------------------------------------------------------------------------

create or replace function public.workspace_member_directory(ws_id text)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = ws_id
    -- The caller must themselves be a member of this workspace.
    and exists (
      select 1 from public.workspace_members me
      where me.workspace_id = ws_id and me.user_id = (select auth.uid())
    );
$$;

revoke all on function public.workspace_member_directory(text) from public;
grant execute on function public.workspace_member_directory(text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Attributed change feed: recent file versions with author + file context.
-- ---------------------------------------------------------------------------

create or replace function public.workspace_change_feed(ws_id text, max_rows integer default 50)
returns table (
  version_id   text,
  file_id      text,
  path         text,
  title        text,
  zone         public.zone,
  version      integer,
  updated_by   public.updated_by,
  author_id    uuid,
  author_email text,
  deleted      boolean,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    v.id,
    f.id,
    f.path,
    f.title,
    f.zone,
    v.version,
    v.updated_by,
    v.author_id,
    u.email::text,
    f.deleted,
    v.created_at
  from public.file_versions v
  join public.files f on f.id = v.file_id
  left join auth.users u on u.id = v.author_id
  where f.workspace_id = ws_id
    and exists (
      select 1 from public.workspace_members me
      where me.workspace_id = ws_id and me.user_id = (select auth.uid())
    )
  order by v.created_at desc, v.id desc
  limit greatest(1, least(coalesce(max_rows, 50), 200));
$$;

revoke all on function public.workspace_change_feed(text, integer) from public;
grant execute on function public.workspace_change_feed(text, integer)
  to authenticated, service_role;

commit;
