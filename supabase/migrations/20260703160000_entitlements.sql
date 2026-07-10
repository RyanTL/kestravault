-- KestraVault — entitlements: owner-funds-hosting, the 3-vault cap, self-host bypass
--
-- Implements the paid-cloud model from plan/sync-collab-open-core.md §2
-- ("Entitlement — owner funds hosting/sync, members bring their own AI") plus
-- the 2026-07-03 vault-cap decision:
--
--   * A user needs an ACTIVE paid cloud+sync plan to create cloud workspaces
--     (vaults) and to share them. One plan covers BOTH the owner's personal
--     vaults and the shared ones — up to 3 cloud vaults per owner.
--   * Members join shared workspaces FREE (account + their own AI key); the
--     check is always against the workspace OWNER's plan, never the member's.
--   * A lapsed owner drops their workspaces to READ-ONLY for everyone — data is
--     never locked away or deleted, but nothing new lands until they renew.
--   * SELF-HOSTING (the AGPL open-core path, §4): an instance flagged
--     self_hosted bypasses every check here — your Postgres, your rules. Flip
--     it once after applying migrations:  update public.instance_config set self_hosted = true;
--
-- Entitlement rows are written ONLY by the service role (the Stripe billing
-- webhook — supabase/functions/billing-webhook); clients can read their own.
--
-- Not applied against a live project (Docker unavailable at authoring time);
-- self-contained, ordered after the sync_commit migration, re-run-safe.

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Instance-wide configuration; exactly one row (id is always true).
create table if not exists public.instance_config (
  id          boolean primary key default true check (id),
  self_hosted boolean not null default false
);
insert into public.instance_config (id, self_hosted)
values (true, false)
on conflict (id) do nothing;

-- One row per user who has (or had) a paid cloud+sync plan.
create table if not exists public.user_entitlements (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  plan                    text not null default 'cloud',
  status                  text not null check (status in ('active', 'lapsed')),
  stripe_customer_id      text,
  stripe_subscription_id  text,
  -- End of the already-paid period; an 'active' row past this instant is
  -- treated as lapsed even before the webhook flips it (belt and braces).
  current_period_end      timestamptz,
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS — users read their own entitlement; only the service role writes.
-- instance_config is world-readable (the app shows "self-hosted mode") and
-- service-role-writable (self-hosters flip it via SQL).
-- ---------------------------------------------------------------------------

alter table public.user_entitlements enable row level security;
alter table public.instance_config   enable row level security;

drop policy if exists user_entitlements_own_select on public.user_entitlements;
create policy user_entitlements_own_select on public.user_entitlements
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists instance_config_read on public.instance_config;
create policy instance_config_read on public.instance_config
  for select to authenticated, anon
  using (true);

-- ---------------------------------------------------------------------------
-- Checks (SECURITY DEFINER so they work from triggers/policies on any table)
-- ---------------------------------------------------------------------------

create or replace function public.instance_is_self_hosted()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.self_hosted from public.instance_config c where c.id), false);
$$;

-- Does this user hold an active paid cloud+sync plan? Always true when the
-- instance is self-hosted.
create or replace function public.user_has_active_plan(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.instance_is_self_hosted()
      or exists (
           select 1 from public.user_entitlements e
           where e.user_id = uid
             and e.status = 'active'
             and (e.current_period_end is null or e.current_period_end > now())
         );
$$;

-- Is this workspace writable? Its OWNER must hold an active plan (a lapsed
-- owner drops the workspace to read-only for everyone — including members).
create or replace function public.workspace_is_writable(ws_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and public.user_has_active_plan(w.owner_id)
  );
$$;

revoke all on function public.instance_is_self_hosted() from public;
revoke all on function public.user_has_active_plan(uuid) from public;
revoke all on function public.workspace_is_writable(text) from public;
grant execute on function public.instance_is_self_hosted() to authenticated, anon, service_role;
grant execute on function public.user_has_active_plan(uuid) to authenticated, service_role;
grant execute on function public.workspace_is_writable(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Creating a cloud workspace requires an active plan + respects the cap.
--    Cap: at most 3 cloud vaults (workspaces) per owner — personal and shared
--    alike, all covered by the one plan. Self-hosted instances skip both.
-- ---------------------------------------------------------------------------

create or replace function public.workspaces_enforce_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  vault_count integer;
begin
  if public.instance_is_self_hosted() then
    return new;
  end if;

  if not public.user_has_active_plan(new.owner_id) then
    raise exception
      'entitlement required: creating a cloud vault requires an active paid cloud+sync plan (or a self-hosted instance)'
      using errcode = 'check_violation';
  end if;

  -- Serialize per-owner creations so two racing inserts cannot both pass the
  -- count (advisory lock keyed on the owner uuid).
  perform pg_advisory_xact_lock(hashtext(new.owner_id::text));

  select count(*) into vault_count
  from public.workspaces w
  where w.owner_id = new.owner_id;

  if vault_count >= 3 then
    raise exception
      'vault cap exceeded: a paid plan covers at most 3 cloud vaults (owner %)',
      new.owner_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists workspaces_enforce_entitlement on public.workspaces;
create trigger workspaces_enforce_entitlement
  before insert on public.workspaces
  for each row execute function public.workspaces_enforce_entitlement();

-- ---------------------------------------------------------------------------
-- 2. Sharing requires the OWNER's active plan: gate invite creation and (for
--    airtightness — redemption inserts member rows through SECURITY DEFINER)
--    non-owner member inserts. Members themselves never need a plan.
-- ---------------------------------------------------------------------------

create or replace function public.require_owner_plan_for_sharing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws_owner uuid;
begin
  -- Owner rows are bookkeeping (auto-enrolled on workspace creation), not sharing.
  if tg_table_name = 'workspace_members' and new.role = 'owner' then
    return new;
  end if;

  select w.owner_id into ws_owner
  from public.workspaces w
  where w.id = new.workspace_id;

  if not public.user_has_active_plan(ws_owner) then
    raise exception
      'entitlement required: sharing workspace % requires its owner to hold an active paid cloud+sync plan',
      new.workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_invites_require_plan on public.workspace_invites;
create trigger workspace_invites_require_plan
  before insert on public.workspace_invites
  for each row execute function public.require_owner_plan_for_sharing();

drop trigger if exists workspace_members_require_plan on public.workspace_members;
create trigger workspace_members_require_plan
  before insert on public.workspace_members
  for each row execute function public.require_owner_plan_for_sharing();

-- ---------------------------------------------------------------------------
-- 3. Lapsed owner → read-only. The membership-scoped ALL policies from the
--    workspace_members migration are split: SELECT stays membership-only, but
--    every write additionally requires the workspace to be writable. Because
--    permissive policies OR together per command, reads keep working while
--    writes stop the moment the owner's plan lapses.
-- ---------------------------------------------------------------------------

-- files
drop policy if exists files_member_access on public.files;
create policy files_member_select on public.files
  for select to authenticated
  using (public.user_is_workspace_member(workspace_id));
create policy files_member_write on public.files
  for all to authenticated
  using (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  )
  with check (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  );

-- change_sets
drop policy if exists change_sets_member_access on public.change_sets;
create policy change_sets_member_select on public.change_sets
  for select to authenticated
  using (public.user_is_workspace_member(workspace_id));
create policy change_sets_member_write on public.change_sets
  for all to authenticated
  using (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  )
  with check (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  );

-- assets
drop policy if exists assets_member_access on public.assets;
create policy assets_member_select on public.assets
  for select to authenticated
  using (public.user_is_workspace_member(workspace_id));
create policy assets_member_write on public.assets
  for all to authenticated
  using (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  )
  with check (
    public.user_is_workspace_member(workspace_id)
    and public.workspace_is_writable(workspace_id)
  );

-- file_versions (scoped via file -> workspace)
drop policy if exists file_versions_member_access on public.file_versions;
create policy file_versions_member_select on public.file_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_is_workspace_member(f.workspace_id)
    )
  );
create policy file_versions_member_write on public.file_versions
  for all to authenticated
  using (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_is_workspace_member(f.workspace_id)
        and public.workspace_is_writable(f.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_is_workspace_member(f.workspace_id)
        and public.workspace_is_writable(f.workspace_id)
    )
  );

-- file_changes (scoped via change_set -> workspace)
drop policy if exists file_changes_member_access on public.file_changes;
create policy file_changes_member_select on public.file_changes
  for select to authenticated
  using (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_is_workspace_member(c.workspace_id)
    )
  );
create policy file_changes_member_write on public.file_changes
  for all to authenticated
  using (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_is_workspace_member(c.workspace_id)
        and public.workspace_is_writable(c.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_is_workspace_member(c.workspace_id)
        and public.workspace_is_writable(c.workspace_id)
    )
  );

-- workspaces: owner mutations (rename/config) also stop while lapsed; the row
-- stays readable to every member so the app can show the read-only state.
drop policy if exists workspaces_owner_update on public.workspaces;
create policy workspaces_owner_update on public.workspaces
  for update to authenticated
  using (
    owner_id = (select auth.uid())
    and public.user_has_active_plan(owner_id)
  )
  with check (
    owner_id = (select auth.uid())
    and public.user_has_active_plan(owner_id)
  );

commit;
