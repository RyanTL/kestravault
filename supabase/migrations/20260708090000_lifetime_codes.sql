-- KestraVault — lifetime access codes (pre-Stripe beta entitlements)
--
-- Until billing goes live, full cloud access is granted by single-use
-- LIFETIME CODES handed out to testers. Redeeming one upserts the caller's
-- `user_entitlements` row to plan 'lifetime' / status 'active' with no period
-- end, which satisfies `user_has_active_plan()` forever — every existing
-- entitlement trigger/policy (vault creation, 3-vault cap, sharing,
-- read-only-on-lapse) keeps working unchanged.
--
--   * Codes are stored only as SHA-256 hashes; the plaintext exists once, at
--     mint time. Format: KV-XXXX-XXXX-XXXX (ambiguity-free alphabet).
--   * `redeem_lifetime_code(code)` — any signed-in user; single-use, atomic.
--   * `mint_lifetime_codes(n, note)` — service role only (SQL editor /
--     scripts/mint-lifetime-codes.mjs); returns the plaintext codes to copy.
--   * When Stripe lands, the billing webhook coexists: it only touches rows
--     for events carrying its own user mapping, and lifetime rows have no
--     stripe ids so no subscription event ever maps onto them.
--
-- Re-run-safe, ordered after asset_storage.

begin;

-- sha-256 + gen_random_bytes (pgcrypto lives in the extensions schema on Supabase).
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.lifetime_codes (
  id          uuid primary key default gen_random_uuid(),
  -- sha256 hex of the normalized (uppercased, whitespace-stripped) code.
  code_hash   text not null unique,
  -- Free-form label: who/what the code is for ("beta batch 1", an email…).
  note        text,
  created_at  timestamptz not null default now(),
  redeemed_by uuid references auth.users (id) on delete set null,
  redeemed_at timestamptz
);

-- RLS on, no policies: clients never read or write this table directly —
-- redemption goes through the SECURITY DEFINER function below, minting is
-- service-role-only.
alter table public.lifetime_codes enable row level security;

-- Normalize exactly the same way at mint and redeem time.
create or replace function public.normalize_lifetime_code(raw text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(coalesce(raw, ''), '\s', '', 'g'));
$$;

create or replace function public.hash_lifetime_code(raw text)
returns text
language sql
immutable
as $$
  select encode(
    extensions.digest(convert_to(public.normalize_lifetime_code(raw), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

-- Redeem a code as the signed-in user. Single-use: the UPDATE claims the row
-- atomically (redeemed_by is null → set), so two racing redeemers cannot both
-- succeed. Grants a lifetime entitlement (no current_period_end).
create or replace function public.redeem_lifetime_code(access_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  claimed uuid;
begin
  if uid is null then
    raise exception 'redeeming a code requires a signed-in user'
      using errcode = 'insufficient_privilege';
  end if;
  if public.normalize_lifetime_code(access_code) = '' then
    raise exception 'invalid or already redeemed code'
      using errcode = 'check_violation';
  end if;

  update public.lifetime_codes
     set redeemed_by = uid,
         redeemed_at = now()
   where code_hash = public.hash_lifetime_code(access_code)
     and redeemed_by is null
  returning id into claimed;

  if claimed is null then
    raise exception 'invalid or already redeemed code'
      using errcode = 'check_violation';
  end if;

  insert into public.user_entitlements (user_id, plan, status, current_period_end, updated_at)
  values (uid, 'lifetime', 'active', null, now())
  on conflict (user_id) do update
     set plan = 'lifetime',
         status = 'active',
         current_period_end = null,
         updated_at = now();

  return true;
end;
$$;

-- Mint `quantity` fresh codes (returned in plaintext — the only time they are
-- visible). Service role only: run from the Supabase SQL editor or the
-- scripts/mint-lifetime-codes.mjs helper.
create or replace function public.mint_lifetime_codes(quantity integer default 1, batch_note text default null)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Crockford-ish: no I, L, O, 0, 1 — codes survive being read aloud.
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea;
  code text;
  i integer;
  b integer;
begin
  if quantity < 1 or quantity > 500 then
    raise exception 'quantity must be between 1 and 500';
  end if;

  for i in 1..quantity loop
    bytes := extensions.gen_random_bytes(12);
    code := 'KV';
    for b in 0..11 loop
      if b % 4 = 0 then
        code := code || '-';
      end if;
      code := code || substr(alphabet, 1 + (get_byte(bytes, b) % length(alphabet)), 1);
    end loop;

    insert into public.lifetime_codes (code_hash, note)
    values (public.hash_lifetime_code(code), batch_note);

    return next code;
  end loop;
end;
$$;

-- Lock the functions down: redemption for signed-in users, minting for the
-- service role, helpers only where needed (hash/normalize are harmless but
-- there's no client use for them).
--
-- IMPORTANT: Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new
-- public function to anon/authenticated/service_role DIRECTLY, so revoking
-- `from public` alone leaves those grants in place (verified on the hosted
-- project — mint stayed callable by any signed-in user). Revoke the direct
-- grants explicitly.
revoke all on function public.normalize_lifetime_code(text) from public, anon, authenticated;
revoke all on function public.hash_lifetime_code(text) from public, anon, authenticated;
revoke all on function public.redeem_lifetime_code(text) from public, anon;
revoke all on function public.mint_lifetime_codes(integer, text) from public, anon, authenticated;
grant execute on function public.redeem_lifetime_code(text) to authenticated;
grant execute on function public.mint_lifetime_codes(integer, text) to service_role;

commit;
