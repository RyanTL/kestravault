#!/usr/bin/env bash
# One-time setup: create .env from .env.example with fresh secrets.
#
# Generates the Postgres password, the JWT secret, and the two Supabase API
# keys (anon + service_role) — HS256 JWTs signed with plain openssl, so the
# only dependency is openssl itself (present on any Linux/NAS/macOS box).
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  echo "error: .env already exists — refusing to overwrite it." >&2
  echo "       (Regenerating keys would orphan your existing users and data." >&2
  echo "        If you really want a clean slate, delete .env and re-run.)" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  echo "error: openssl is required but not found." >&2
  exit 1
}

# base64url without padding, as JWT wants it.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# jwt <role> <secret> — a Supabase API key: HS256 JWT with a ~10 year expiry.
jwt() {
  local role=$1 secret=$2 now exp header payload signature
  now=$(date +%s)
  exp=$((now + 10 * 365 * 24 * 3600))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$role" "$now" "$exp" | b64url)
  signature=$(printf '%s.%s' "$header" "$payload" |
    openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)      # 64 hex chars — comfortably over GoTrue's minimum
SECRET_KEY_BASE=$(openssl rand -hex 32) # realtime wants a 64-char key base
ANON_KEY=$(jwt anon "$JWT_SECRET")
SERVICE_ROLE_KEY=$(jwt service_role "$JWT_SECRET")

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^ANON_KEY=.*|ANON_KEY=${ANON_KEY}|" \
  -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}|" \
  -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=${SECRET_KEY_BASE}|" \
  .env.example >.env
chmod 600 .env

cat <<EOF
Wrote .env with fresh secrets (file is chmod 600; keep it out of git — it already is).

Your API keys (also in .env):

  anon key (goes in the app's Settings → Sync server):
  ${ANON_KEY}

  service_role key (server-side only — NEVER paste this into a client):
  ${SERVICE_ROLE_KEY}

Next steps:
  1. Edit .env: set API_EXTERNAL_URL + SITE_URL to the URL your devices will
     actually use (Tailscale MagicDNS name, or http://<lan-ip>:8000).
  2. docker compose up -d          (add --profile tailscale / --profile studio)
  3. ./migrate.sh                  (applies the KestraVault schema)

Full guide: ./README.md
EOF
