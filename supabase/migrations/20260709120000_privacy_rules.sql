-- KestraVault — path-level privacy rules
--
-- Cloud-synced privacy metadata for notes/folders:
--   * public             — normal sync, remote AI may read content.
--   * cloud-ai-private   — normal sync, but app/orchestrator hides bodies from
--                          remote AI and agent tool mounts.
--
-- `local-only` deliberately does NOT exist in this schema. Local-only rules live
-- only in `.kestravault/privacy.local.json`; when a user marks a path local-only,
-- the sync engine soft-deletes any matching cloud files instead of uploading a
-- privacy row.

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'privacy_mode') then
    create type public.privacy_mode as enum ('public', 'cloud-ai-private');
  end if;
  if not exists (select 1 from pg_type where typname = 'privacy_target') then
    create type public.privacy_target as enum ('file', 'folder');
  end if;
end $$;

create table public.privacy_rules (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  path         text not null,
  target       public.privacy_target not null,
  mode         public.privacy_mode not null,
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false,
  primary key (workspace_id, path, target)
);

create index privacy_rules_workspace_idx on public.privacy_rules (workspace_id);

alter table public.privacy_rules enable row level security;

create policy privacy_rules_member_access on public.privacy_rules
  for all to authenticated
  using (public.user_is_workspace_member(workspace_id))
  with check (public.user_is_workspace_member(workspace_id));

alter table public.privacy_rules replica identity full;
alter publication supabase_realtime add table public.privacy_rules;

commit;
