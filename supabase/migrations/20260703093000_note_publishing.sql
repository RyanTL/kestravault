-- KestraVault — note publishing via public link (Feature B)
--
-- Implements the data model + anonymous read path of
-- plan/sync-collab-open-core.md §3. Builds on 20260627000000_init_canonical_store
-- (tables, owner-scoped RLS, user_owns_workspace) and follows the trigger style
-- of 20260629000000_zone_enforcement.
--
-- Design (locked in the plan, conservative where it was silent):
--   * Only notes/ files are publishable — never wiki/ or sources/ — enforced
--     with a trigger so it holds for EVERY writer, service role included.
--   * The public link is LIVE (reads the current note; no snapshot) and
--     read-only for anonymous visitors (no account).
--   * Revocation: unpublish flips `published` and the token stops resolving in
--     the same instant. Re-publishing must mint a FRESH token (trigger-enforced)
--     so a revoked link can never come back to life.
--   * Unlisted posture: the token is an unguessable capability, so it must not
--     be enumerable. note_publications has NO anonymous access at all; the
--     anonymous read paths below only ever go token -> note, never note -> token.
--   * Zero graph leak: anonymous access is scoped to the published file row
--     itself — nothing it links to. ([[wikilink]] flattening happens in
--     packages/core/src/publish/; the database simply never grants more than
--     the one row.)
--
-- Not applied against a live project (no local Supabase at authoring time);
-- self-contained, ordered after the existing migrations, re-run-safe
-- (create-or-replace functions; drop-if-exists before each trigger/policy).

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-note publish state.
--    One row per note, keyed by file. `published` is the live switch;
--    `public_token` is the capability carried in the URL.
-- ---------------------------------------------------------------------------

create table public.note_publications (
  file_id      text primary key references public.files (id) on delete cascade,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  published    boolean not null default true,
  public_token text not null unique,
  published_at timestamptz not null default now(),
  -- Tokens are app-minted CSPRNG values (64 hex chars — see
  -- packages/core/src/data/publishing.ts `mintPublicToken`). Guard against a
  -- buggy client writing something guessably short.
  constraint note_publications_token_length check (char_length(public_token) >= 32)
);

create index note_publications_workspace_id_idx on public.note_publications (workspace_id);
-- public_token lookups ride the unique constraint's index.

-- ---------------------------------------------------------------------------
-- 2. Only notes/ files are publishable (never wiki/ or sources/).
--    RLS can't express this (the service role bypasses RLS), so it's a trigger,
--    like the zone-permission matrix in 20260629000000.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_publishable_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_zone public.zone;
begin
  select f.zone into target_zone
  from public.files f
  where f.id = new.file_id and f.workspace_id = new.workspace_id;

  if target_zone is null then
    raise exception
      'publish violation: file % does not exist in workspace %',
      new.file_id, new.workspace_id
      using errcode = 'check_violation';
  end if;

  if target_zone <> 'notes' then
    raise exception
      'publish violation: only notes/ files are publishable; file % is in zone %',
      new.file_id, target_zone
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists note_publications_enforce_zone on public.note_publications;
create trigger note_publications_enforce_zone
  before insert or update on public.note_publications
  for each row execute function public.enforce_publishable_zone();

-- Re-publishing after a revocation must mint a fresh token — otherwise the
-- old, "invalidated" link would silently start working again.
create or replace function public.enforce_publish_token_rotation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.published and not old.published and new.public_token = old.public_token then
    raise exception
      'publish violation: re-publishing file % must mint a fresh public token',
      new.file_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists note_publications_token_rotation on public.note_publications;
create trigger note_publications_token_rotation
  before update on public.note_publications
  for each row execute function public.enforce_publish_token_rotation();

-- ---------------------------------------------------------------------------
-- 3. RLS — owners manage their own publications; anonymous users get NOTHING
--    from this table (tokens must never be enumerable).
-- ---------------------------------------------------------------------------

alter table public.note_publications enable row level security;

drop policy if exists note_publications_owner_access on public.note_publications;
create policy note_publications_owner_access on public.note_publications
  for all to authenticated
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

-- Belt and braces for the unlisted posture: even a future misconfigured policy
-- shouldn't hand the anon role token columns via a `select *`.
revoke all on public.note_publications from anon;

-- ---------------------------------------------------------------------------
-- 4. Anonymous read paths — token-gated, and only for currently-published,
--    live, notes-zone files. Two mechanisms, both fail-closed:
--
--    (a) fetch_published_note(token): the sanctioned path the render route
--        uses. SECURITY DEFINER; returns a NARROW projection (no ids, paths,
--        versions, authorship) for exactly the note whose token was presented.
--
--    (b) an RLS SELECT policy on files for the anon role, gated on the caller
--        presenting the matching token in the `x-kestravault-publish-token` request
--        header (PostgREST exposes headers via the request.headers GUC). With
--        no/wrong token the policy sees NULL and matches nothing — anonymous
--        users can never list or scrape published notes. Nothing a published
--        note links to gains any access: the policy matches only the published
--        row itself.
-- ---------------------------------------------------------------------------

-- The publish token presented by the current (PostgREST) request, or null.
create or replace function public.requested_publish_token()
returns text
language sql
stable
set search_path = public
as $$
  select nullif(
    coalesce(current_setting('request.headers', true), '{}')::jsonb
      ->> 'x-kestravault-publish-token',
    ''
  );
$$;

-- Does this token unlock this file? SECURITY DEFINER so the check can read
-- note_publications from a files policy without granting anon any direct
-- access to the tokens table (same pattern as user_owns_workspace).
create or replace function public.file_published_for_token(f_id text, token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select token is not null
    and exists (
      select 1
      from public.note_publications p
      where p.file_id = f_id
        and p.published
        and p.public_token = token
    );
$$;

drop policy if exists files_published_anon_read on public.files;
create policy files_published_anon_read on public.files
  for select to anon
  using (
    zone = 'notes'
    and not deleted
    and public.file_published_for_token(id, public.requested_publish_token())
  );

-- Column hygiene: the anon role only ever needs the reader-facing columns.
revoke all on public.files from anon;
grant select (id, title, content, updated_at) on public.files to anon;

-- (a) The sanctioned token -> published-note lookup for the future render route.
create or replace function public.fetch_published_note(note_token text)
returns table (
  title        text,
  content      text,
  published_at timestamptz,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select f.title, f.content, p.published_at, f.updated_at
  from public.note_publications p
  join public.files f on f.id = p.file_id
  where note_token is not null
    and note_token <> ''
    and p.public_token = note_token
    and p.published
    and f.zone = 'notes'
    and not f.deleted;
$$;

revoke all on function public.fetch_published_note(text) from public;
grant execute on function public.fetch_published_note(text) to anon, authenticated, service_role;

commit;
