#!/usr/bin/env node
// Mint lifetime access codes on the hosted Supabase project (pre-Stripe beta).
//
//   SUPABASE_SERVICE_ROLE_KEY=eyJ… node scripts/mint-lifetime-codes.mjs [count] [note]
//
// Prints the plaintext codes — the ONLY time they're visible (the database
// stores hashes). Copy them somewhere safe and hand them to testers; each is
// single-use and grants a permanent 'lifetime' cloud entitlement on redeem
// (Settings → Sync & sharing → "Redeem access code").
//
// The service-role key is in the Supabase dashboard → Settings → API. It is a
// SECRET — never commit it, never ship it to clients.

const url = process.env.KESTRAVAULT_SUPABASE_URL ?? "https://logmyyhpktrichwgumsd.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const count = Number(process.argv[2] ?? "10");
const note = process.argv[3] ?? `beta batch ${new Date().toISOString().slice(0, 10)}`;

if (!key) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY (dashboard → Settings → API → service_role).");
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > 500) {
  console.error("Count must be an integer between 1 and 500.");
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/rpc/mint_lifetime_codes`, {
  method: "POST",
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ quantity: count, batch_note: note }),
});

if (!res.ok) {
  console.error(`Minting failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}

const codes = await res.json();
console.log(`Minted ${codes.length} lifetime code(s) — note: "${note}"\n`);
for (const code of codes) console.log(`  ${code}`);
console.log("\nEach code is single-use. The database only stores hashes — save these now.");
