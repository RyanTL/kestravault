-- KestraVault — shared workspaces (Feature A): membership, invites, RLS-by-membership
--
-- Implements plan/sync-collab-open-core.md §2 "Membership plumbing":
--   * workspace_members(workspace_id, user_id, role owner|member, created_at) —
--     a workspace has ONE owner plus AT MOST 3 invited members (4 people total).
--   * workspace_invites — single-use, expiring invite tokens (invite-by-link or
--     invite-by-email; redeemed via the SECURITY DEFINER redeem function below,
--     never by direct table access).
--   * Access is governed by MEMBERSHIP, not ownership: the owner-scoped RLS from
--     20260627000000_init_canonical_store.sql is rewritten so files, change_sets,
--     file_versions, file_changes, and assets are visible to every member of the
--     workspace ("is this user a member", not "is this user the owner").
--   * The 3-member cap is enforced HERE, server-side (BEFORE INSERT trigger with
--     a row lock on the parent workspace), never UI-only.
--
-- Existing owners are backfilled as the 'owner' member of their workspaces, and
-- a trigger keeps that invariant for new workspaces — so membership is the single
-- authoritative access list (an owner without a member row would lose access
-- under membership-scoped RLS).
--
-- Out of scope here (per the plan): presence, change-feed attribution UI,
-- conflict UX (O8), and Stripe entitlements — see the TODO at the cap trigger.
--
-- Not applied against a live project (Docker unavailable at authoring time);
-- migration is self-contained, ordered after the zone-enforcement migration, and
-- re-run-safe (create-or-replace functions; drop-if-exists before each trigger
-- and policy).

begin;

-- ---------------------------------------------------------------------------
-- Enums (mirror packages/core/src/types/members.ts)
-- ---------------------------------------------------------------------------

-- The two workspace roles — deliberately only two (richer roles are Teams, O6).
create type public.member_role as enum ('owner', 'member');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per person with access to a workspace. Exactly one 'owner' row (the
-- workspace's owner_id) plus at most 3 'member' rows — 4 people total.
create table public.workspace_members (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.member_role not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- A single-use, expiring invite to join a workspace as a 'member'.
-- invited_email null = invite-by-link (anyone with the token); non-null =
-- invite-by-email (the redeeming account's email must match).
create table public.workspace_invites (
  id            text primary key,
  token         text not null unique,  -- app-generated, high-entropy; the link IS the secret
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  invited_email text,
  expires_at    timestamptz not null,
  redeemed_by   uuid references auth.users (id) on delete set null,  -- null until redeemed (single-use)
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (foreign keys + common lookups)
-- ---------------------------------------------------------------------------

create index workspace_members_user_id_idx    on public.workspace_members (user_id);
-- Exactly one owner row per workspace.
create unique index workspace_members_one_owner_idx
  on public.workspace_members (workspace_id) where role = 'owner';
create index workspace_invites_workspace_idx  on public.workspace_invites (workspace_id);

-- ---------------------------------------------------------------------------
-- 1. The 3-member cap + membership integrity (server-side, race-proof).
-- ---------------------------------------------------------------------------

-- TODO(entitlements): once Stripe/billing is live, this is where the
-- owner-must-have-an-active-paid-plan check belongs (plan §2 "Entitlement":
-- owner funds hosting/sync → workspace may add free members; a lapsed owner
-- drops the workspace to read-only). Blocked on billing — no fake check here.

create or replace function public.workspace_members_enforce_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_count integer;
begin
  -- The 'owner' row must be the workspace's actual owner.
  if new.role = 'owner' then
    if not exists (
      select 1 from public.workspaces w
      where w.id = new.workspace_id and w.owner_id = new.user_id
    ) then
      raise exception
        'membership violation: the owner row of workspace % must be its owner_id',
        new.workspace_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Lock the parent workspace row so concurrent member inserts serialize —
  -- two racing invites cannot both read "2 members" and land a 4th person.
  perform 1 from public.workspaces w where w.id = new.workspace_id for update;

  select count(*) into member_count
  from public.workspace_members m
  where m.workspace_id = new.workspace_id and m.role = 'member';

  if member_count >= 3 then
    raise exception
      'member cap exceeded: workspace % already has 3 members (owner + 3 people maximum)',
      new.workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_members_enforce_cap on public.workspace_members;
create trigger workspace_members_enforce_cap
  before insert on public.workspace_members
  for each row execute function public.workspace_members_enforce_cap();

-- Membership rows are add/remove only — no in-place role changes (an owner
-- swap is an ownership transfer, which is not a v1 feature).
create or replace function public.block_workspace_member_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'workspace_members rows are immutable; remove and re-add to change membership'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists workspace_members_block_update on public.workspace_members;
create trigger workspace_members_block_update
  before update on public.workspace_members
  for each row execute function public.block_workspace_member_update();

-- The owner row cannot be deleted — a workspace always has its owner as a
-- member (rows still cascade-delete with the workspace itself).
create or replace function public.block_owner_member_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner' then
    raise exception
      'membership violation: the owner row of workspace % cannot be removed',
      old.workspace_id
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists workspace_members_block_owner_delete on public.workspace_members;
create trigger workspace_members_block_owner_delete
  before delete on public.workspace_members
  for each row execute function public.block_owner_member_delete();

-- ---------------------------------------------------------------------------
-- 2. Membership is authoritative: backfill existing owners, auto-enroll new ones.
-- ---------------------------------------------------------------------------

insert into public.workspace_members (workspace_id, user_id, role, created_at)
select w.id, w.owner_id, 'owner', w.created_at
from public.workspaces w
on conflict (workspace_id, user_id) do nothing;

create or replace function public.add_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

drop trigger if exists workspaces_add_owner_membership on public.workspaces;
create trigger workspaces_add_owner_membership
  after insert on public.workspaces
  for each row execute function public.add_owner_membership();

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security — rewritten from owner scope to MEMBERSHIP scope.
--    A user sees a workspace's rows iff they are a member (owner or member);
--    only the owner manages membership and invites.
-- ---------------------------------------------------------------------------

-- Helper: is the current user a member (any role) of this workspace? SECURITY
-- DEFINER so the check works uniformly from descendant tables without granting
-- direct reads (mirrors user_owns_workspace from the init migration, which is
-- kept for owner-only operations below).
create or replace function public.user_is_workspace_member(ws_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws_id and m.user_id = (select auth.uid())
  );
$$;

alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

-- workspace_members: every member can see who else is in the workspace; only
-- the owner adds/removes members (invite redemption goes through the SECURITY
-- DEFINER function below, not a direct insert).
create policy workspace_members_member_select on public.workspace_members
  for select to authenticated
  using (public.user_is_workspace_member(workspace_id));

create policy workspace_members_owner_insert on public.workspace_members
  for insert to authenticated
  with check (public.user_owns_workspace(workspace_id));

create policy workspace_members_owner_delete on public.workspace_members
  for delete to authenticated
  using (public.user_owns_workspace(workspace_id));

-- workspace_invites: owner-only (create / list / revoke). Redeemers never read
-- this table directly — a policy keyed on "knows the token" cannot be expressed
-- in RLS without exposing all rows, so redemption is the function below.
create policy workspace_invites_owner_access on public.workspace_invites
  for all to authenticated
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

-- workspaces: members can see the workspace; only the owner mutates it.
drop policy if exists workspaces_owner_access on public.workspaces;

create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or public.user_is_workspace_member(id)
  );

create policy workspaces_owner_insert on public.workspaces
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy workspaces_owner_update on public.workspaces
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy workspaces_owner_delete on public.workspaces
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- files: scoped via membership in the parent workspace (members have equal
-- read/write to sources/, wiki/, notes/ — the zone triggers still gate the
-- agent's writes, and versioning attributes every change).
drop policy if exists files_owner_access on public.files;
create policy files_member_access on public.files
  for all to authenticated
  using (public.user_is_workspace_member(workspace_id))
  with check (public.user_is_workspace_member(workspace_id));

-- change_sets: scoped via membership in the parent workspace.
drop policy if exists change_sets_owner_access on public.change_sets;
create policy change_sets_member_access on public.change_sets
  for all to authenticated
  using (public.user_is_workspace_member(workspace_id))
  with check (public.user_is_workspace_member(workspace_id));

-- assets: scoped via membership in the parent workspace.
drop policy if exists assets_owner_access on public.assets;
create policy assets_member_access on public.assets
  for all to authenticated
  using (public.user_is_workspace_member(workspace_id))
  with check (public.user_is_workspace_member(workspace_id));

-- file_versions: scoped via file -> workspace membership.
drop policy if exists file_versions_owner_access on public.file_versions;
create policy file_versions_member_access on public.file_versions
  for all to authenticated
  using (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_is_workspace_member(f.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_is_workspace_member(f.workspace_id)
    )
  );

-- file_changes: scoped via change_set -> workspace membership.
drop policy if exists file_changes_owner_access on public.file_changes;
create policy file_changes_member_access on public.file_changes
  for all to authenticated
  using (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_is_workspace_member(c.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_is_workspace_member(c.workspace_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Invite redemption — single-use, expiring, cap-checked, atomic.
--    SECURITY DEFINER because the redeemer is NOT yet a member: they cannot see
--    the invite row (or the workspace) under RLS. The token itself is the
--    credential; everything else is derived from the caller's auth context.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_workspace_invite(invite_token text)
returns public.workspace_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid    uuid;
  invite public.workspace_invites;
  member public.workspace_members;
begin
  uid := (select auth.uid());
  if uid is null then
    raise exception 'invite redemption requires an authenticated user'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the invite row so two concurrent redemptions of the same token
  -- serialize — exactly one can win.
  select * into invite
  from public.workspace_invites i
  where i.token = invite_token
  for update;

  if not found then
    raise exception 'invalid invite token' using errcode = 'no_data_found';
  end if;
  if invite.redeemed_by is not null then
    raise exception 'invite already redeemed (invites are single-use)'
      using errcode = 'check_violation';
  end if;
  if invite.expires_at <= now() then
    raise exception 'invite expired at %', invite.expires_at
      using errcode = 'check_violation';
  end if;
  -- Email-targeted invites are only redeemable by that email's account.
  if invite.invited_email is not null
     and lower(invite.invited_email) is distinct from lower((select auth.jwt() ->> 'email')) then
    raise exception 'invite is addressed to a different email'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.workspace_members m
    where m.workspace_id = invite.workspace_id and m.user_id = uid
  ) then
    raise exception 'already a member of workspace %', invite.workspace_id
      using errcode = 'unique_violation';
  end if;

  -- The BEFORE INSERT cap trigger fires here; if the workspace is full the
  -- whole transaction rolls back and the token is NOT burned.
  insert into public.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, uid, 'member')
  returning * into member;

  update public.workspace_invites
  set redeemed_by = uid
  where id = invite.id;

  return member;
end;
$$;

-- The function is the only redemption path: callable by signed-in users (and
-- the service role), never anonymously.
revoke all on function public.redeem_workspace_invite(text) from public;
grant execute on function public.redeem_workspace_invite(text) to authenticated, service_role;

commit;
