-- Schema the Realtime service manages its tenant state in (it runs its own
-- migrations inside _realtime at boot; SEED_SELF_HOST creates the tenant).
create schema if not exists _realtime;
alter schema _realtime owner to supabase_admin;
