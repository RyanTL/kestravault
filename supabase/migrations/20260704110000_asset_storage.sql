-- KestraVault — binary asset sync (images embedded in notes)
--
-- Storage plumbing for the desktop asset-sync pass (apps/desktop/src/main/
-- sync.ts + assets.ts): notes embed images with standard markdown; the bytes
-- live in the private "vault-assets" storage bucket at
-- `<workspace_id>/<vault-relative-path>` and the existing `public.assets`
-- table is the metadata index (sha256 drives change detection).
--
--   1. the bucket (private — access only through member-scoped policies);
--   2. storage.objects RLS: a user touches an object iff they are a member of
--      the workspace named by the object's first path segment (same
--      membership boundary as every other table);
--   3. a uniqueness guarantee on (workspace_id, storage_path) so the client's
--      upsert-by-path is well-defined;
--   4. `assets` joins the realtime publication so other devices hear about
--      new uploads without waiting for the interval sync.
--
-- Re-run-safe: on-conflict guards, drop-if-exists before each policy, and a
-- guarded publication add.

begin;

-- ---------------------------------------------------------------------------
-- 1. The bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('vault-assets', 'vault-assets', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Member-scoped object access
-- ---------------------------------------------------------------------------

drop policy if exists vault_assets_member_select on storage.objects;
create policy vault_assets_member_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vault-assets'
    and public.user_is_workspace_member(split_part(name, '/', 1))
  );

drop policy if exists vault_assets_member_insert on storage.objects;
create policy vault_assets_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-assets'
    and public.user_is_workspace_member(split_part(name, '/', 1))
  );

drop policy if exists vault_assets_member_update on storage.objects;
create policy vault_assets_member_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'vault-assets'
    and public.user_is_workspace_member(split_part(name, '/', 1))
  )
  with check (
    bucket_id = 'vault-assets'
    and public.user_is_workspace_member(split_part(name, '/', 1))
  );

drop policy if exists vault_assets_member_delete on storage.objects;
create policy vault_assets_member_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'vault-assets'
    and public.user_is_workspace_member(split_part(name, '/', 1))
  );

-- ---------------------------------------------------------------------------
-- 3. One assets row per (workspace, storage path) — the client upserts on it
-- ---------------------------------------------------------------------------

create unique index if not exists assets_workspace_storage_path_idx
  on public.assets (workspace_id, storage_path);

-- ---------------------------------------------------------------------------
-- 4. Realtime: broadcast asset inserts/updates like files/change_sets
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'assets'
  ) then
    alter publication supabase_realtime add table public.assets;
  end if;
end;
$$;

commit;
