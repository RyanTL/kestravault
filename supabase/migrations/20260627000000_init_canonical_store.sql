-- KestraVault canonical store
-- Implements the "Server canonical schema" in plan/data-model.md column-for-column:
-- workspaces, files, file_versions, change_sets, file_changes, assets.
--
-- Notes:
--   * IDs are ULIDs (26-char Crockford base32 strings, app-generated) -> `text`,
--     consistent with packages/core/src/types/ids.ts (`Ulid = string`).
--   * owner_id references Supabase auth (`auth.users.id`, a uuid).
--   * RLS scopes every row to the owning user (owner_id), so a user sees only
--     their own workspaces and all descendant rows.
--   * Realtime is enabled on `files` and `change_sets` so clients update live.
--
-- This is the ONLY migration (migrations are serialized); keep it self-contained.

begin;

-- ---------------------------------------------------------------------------
-- Enums (mirror packages/core/src/types/enums.ts)
-- ---------------------------------------------------------------------------

-- The three ownership zones of a workspace.
create type public.zone as enum ('sources', 'wiki', 'notes');

-- The `type` field carried in a file's frontmatter.
create type public.file_type as enum (
  'source',
  'entity',
  'concept',
  'topic',
  'overview',
  'comparison',
  'source-summary',
  'note',
  'index',
  'log',
  'instructions'
);

-- Who authored a given file version.
create type public.updated_by as enum ('human', 'agent');

-- What kind of operation produced a change-set.
create type public.change_set_kind as enum ('ingest', 'query_fileback', 'lint', 'manual');

-- The per-file operation recorded inside a change-set.
create type public.file_op as enum ('create', 'update', 'delete');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A "brain": an isolated tree of sources/wiki/notes the agent never crosses.
create table public.workspaces (
  id         text primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  config     jsonb not null default '{}'::jsonb
);

-- The current state of one markdown file in a workspace.
create table public.files (
  id           text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  path         text not null,        -- workspace-relative, e.g. wiki/concepts/ownership.md
  zone         public.zone not null,
  type         public.file_type not null,
  title        text not null,
  content      text not null default '',
  sha256       text not null,        -- lowercase-hex SHA-256 of content
  version      integer not null default 1,
  updated_by   public.updated_by not null,
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false
);

-- An immutable historical version of a file (backs 3-way merge + undo).
create table public.change_sets (
  id           text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  kind         public.change_set_kind not null,
  summary      text not null default '',
  source_event jsonb,                -- triggering event (e.g. source id + content hash), nullable
  created_at   timestamptz not null default now(),
  reverted     boolean not null default false
);

-- One immutable historical version of a file.
create table public.file_versions (
  id            text primary key,
  file_id       text not null references public.files (id) on delete cascade,
  version       integer not null,
  content       text not null,
  sha256        text not null,
  updated_by    public.updated_by not null,
  change_set_id text references public.change_sets (id) on delete set null,  -- null for plain human edits
  created_at    timestamptz not null default now(),
  unique (file_id, version)
);

-- A single file's change within a change-set, with a unified diff.
create table public.file_changes (
  id             text primary key,
  change_set_id  text not null references public.change_sets (id) on delete cascade,
  file_id        text not null references public.files (id) on delete cascade,
  op             public.file_op not null,
  before_version integer,            -- null on create
  after_version  integer,            -- null on delete
  diff           text not null default ''
);

-- A binary attachment (image, PDF source, ...) stored in Supabase Storage.
create table public.assets (
  id           text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  storage_path text not null,
  mime         text not null,
  sha256       text not null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (foreign keys + common lookups)
-- ---------------------------------------------------------------------------

create index workspaces_owner_id_idx       on public.workspaces (owner_id);
create index files_workspace_id_idx        on public.files (workspace_id);
-- A path is unique within a workspace among live (non-deleted) files.
create unique index files_workspace_path_idx
  on public.files (workspace_id, path) where deleted = false;
create index change_sets_workspace_id_idx  on public.change_sets (workspace_id);
create index file_versions_file_id_idx     on public.file_versions (file_id);
create index file_versions_change_set_idx  on public.file_versions (change_set_id);
create index file_changes_change_set_idx   on public.file_changes (change_set_id);
create index file_changes_file_id_idx      on public.file_changes (file_id);
create index assets_workspace_id_idx       on public.assets (workspace_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security — every row is scoped to the owning user (owner_id).
-- A user can see/modify only their own workspaces and all descendant rows.
-- ---------------------------------------------------------------------------

-- Helper: does the current user own this workspace? SECURITY DEFINER so the
-- check works uniformly from descendant tables without granting direct reads.
create function public.user_owns_workspace(ws_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = (select auth.uid())
  );
$$;

alter table public.workspaces    enable row level security;
alter table public.files         enable row level security;
alter table public.change_sets   enable row level security;
alter table public.file_versions enable row level security;
alter table public.file_changes  enable row level security;
alter table public.assets        enable row level security;

-- workspaces: the user owns the row directly.
create policy workspaces_owner_access on public.workspaces
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- files: scoped via the parent workspace.
create policy files_owner_access on public.files
  for all to authenticated
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

-- change_sets: scoped via the parent workspace.
create policy change_sets_owner_access on public.change_sets
  for all to authenticated
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

-- assets: scoped via the parent workspace.
create policy assets_owner_access on public.assets
  for all to authenticated
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

-- file_versions: scoped via file -> workspace.
create policy file_versions_owner_access on public.file_versions
  for all to authenticated
  using (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_owns_workspace(f.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.files f
      where f.id = file_versions.file_id
        and public.user_owns_workspace(f.workspace_id)
    )
  );

-- file_changes: scoped via change_set -> workspace.
create policy file_changes_owner_access on public.file_changes
  for all to authenticated
  using (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_owns_workspace(c.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.change_sets c
      where c.id = file_changes.change_set_id
        and public.user_owns_workspace(c.workspace_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime — broadcast inserts/updates on files and change_sets so clients
-- (desktop folder mirror, mobile view) update live. RLS still applies to the
-- realtime stream, so users only receive their own rows.
-- ---------------------------------------------------------------------------

alter table public.files       replica identity full;
alter table public.change_sets replica identity full;

alter publication supabase_realtime add table public.files;
alter publication supabase_realtime add table public.change_sets;

commit;
