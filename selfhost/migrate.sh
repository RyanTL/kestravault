#!/usr/bin/env bash
# Apply the KestraVault schema (../supabase/migrations/*.sql) to the running stack.
#
# Idempotent: applied versions are tracked in supabase_migrations.schema_migrations
# (the same convention the Supabase CLI uses), so re-running only applies what's
# new — this is also the upgrade path after a git pull.
set -euo pipefail
cd "$(dirname "$0")"

MIGRATIONS_DIR=../supabase/migrations

psql_db() {
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

# Wait for the database (fresh `up -d` may still be initializing).
echo "Waiting for the database…"
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U postgres -h localhost >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" == 30 ]]; then
    echo "error: database not ready after 60s — is the stack up? (docker compose up -d)" >&2
    exit 1
  fi
  sleep 2
done

# Bootstrap: the migration-tracking table, plus the supabase_realtime
# publication our schema adds tables to (created by the hosted platform and
# the CLI, but not guaranteed by a bare self-host image).
psql_db <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  name       text,
  applied_at timestamptz not null default now()
);
do $$
begin
  if not exists (select from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
SQL

shopt -s nullglob
applied=0 skipped=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  base=$(basename "$f")
  version=${base%%_*}
  name=${base#*_}
  name=${name%.sql}
  exists=$(psql_db -tAc "select 1 from supabase_migrations.schema_migrations where version = '${version}'")
  if [[ "$exists" == "1" ]]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "Applying ${base}…"
  psql_db <"$f"
  psql_db -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}')"
  applied=$((applied + 1))
done

echo "Done: ${applied} applied, ${skipped} already up to date."
