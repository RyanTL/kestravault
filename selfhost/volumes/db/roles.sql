-- Set passwords for the service roles the supabase/postgres image ships with.
-- Runs once, on first boot of an empty data volume ($POSTGRES_PASSWORD comes
-- from .env). Guarded per-role so a missing role never aborts init.
\set pgpass `echo "$POSTGRES_PASSWORD"`

select set_config('kestravault.pgpass', :'pgpass', false);

do $$
declare
  r text;
begin
  foreach r in array array[
    'authenticator',
    'pgbouncer',
    'supabase_auth_admin',
    'supabase_functions_admin',
    'supabase_storage_admin'
  ] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('alter user %I with password %L', r, current_setting('kestravault.pgpass'));
    end if;
  end loop;
end
$$;

select set_config('kestravault.pgpass', '', false);
