# Self-hosting KestraVault

Run the whole KestraVault backend — database, auth, sync, storage, realtime, edge
functions — on your own server. A home server is the target: a NAS, a mini-PC,
an old laptop, a Raspberry Pi 4/5 with enough RAM.

> **What you get today:** your own private backend for accounts + multi-device
> sync, reachable from all your devices over [Tailscale](https://tailscale.com)
> with zero port-forwarding and automatic HTTPS.
>
> **What you don't get (yet):** the hosted cloud agent (Anthropic Managed
> Agents) cannot run on your server. Self-hosted AI = the BYO-model providers
> in Settings → AI model (Ollama, LM Studio, your own API keys). The portable
> agent loop that closes this gap is on the roadmap
> ([plan/self-hosting.md](../plan/self-hosting.md)).

## Requirements

- **Docker + Docker Compose v2** (`docker compose`, not `docker-compose`).
- **4 GB+ RAM** for the stack (Postgres, gateway, auth, realtime, storage,
  functions). A 2 GB Pi is not enough; a Pi 4/5 with 4–8 GB is fine.
- **amd64 or arm64.** All images ship both architectures.
- `openssl` (for `setup.sh` — preinstalled on Linux/macOS/NAS shells).

## Quickstart

```bash
git clone https://github.com/RyanTL/kestravault.git
cd kestravault/selfhost

./setup.sh            # generates .env: passwords, JWT secret, anon/service keys
nano .env             # set API_EXTERNAL_URL + SITE_URL (see below — required!)

docker compose up -d  # first run pulls ~2 GB of images
./migrate.sh          # applies the KestraVault schema
```

Smoke test (expect `{"date":...}` JSON, not an error):

```bash
source .env
curl -H "apikey: $ANON_KEY" "$API_EXTERNAL_URL/auth/v1/health"
```

Then in the KestraVault app: **Settings → Sync server**, paste your server URL and
the **anon key** `setup.sh` printed, and hit **Test connection**.

## The URL decision (read this before `up -d`)

`API_EXTERNAL_URL` and `SITE_URL` in `.env` must be the URL your devices
_actually reach the server at_. Auth bakes it into redirects and tokens — if
it's wrong, sign-in and realtime break in confusing ways. Pick one:

| Path                        | `.env` value                       | Reach                              |
| --------------------------- | ---------------------------------- | ---------------------------------- |
| **Tailscale (recommended)** | `https://kestravault.<tailnet>.ts.net` | Anywhere, HTTPS, no open ports     |
| LAN only                    | `http://192.168.x.x:8000`          | Same network only                  |
| Public reverse proxy        | `https://your.domain`              | Anywhere — discouraged (see below) |

If you change these later: `docker compose up -d` again to recreate the
affected services.

## The Tailscale path (recommended)

Why this is the blessed route for a home server:

- **No port forwarding, no domain, no DDNS.** Works behind CGNAT (most home
  ISPs) because Tailscale's WireGuard mesh punches through NAT.
- **Real HTTPS for free.** Tailscale Serve fronts the API gateway with an
  automatically provisioned certificate — normally the most painful part of
  self-hosting Supabase.
- **Phones just work.** Install Tailscale on your phone, and the mobile app
  reaches the same URL.

### Option A — sidecar container (easiest)

The stack includes a Tailscale sidecar that joins your tailnet and serves the
API over HTTPS by itself:

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
   enable **MagicDNS** and **HTTPS certificates**.
2. Create an [auth key](https://login.tailscale.com/admin/settings/keys) and
   put it in `.env` as `TS_AUTHKEY`. Pick a node name via `TS_HOSTNAME`
   (default `kestravault`).
3. Set in `.env` (replace `<tailnet>` with yours, e.g. `tail1234.ts.net`):
   ```
   API_EXTERNAL_URL=https://kestravault.<tailnet>.ts.net
   SITE_URL=https://kestravault.<tailnet>.ts.net
   ```
4. Start with the profile:
   ```bash
   docker compose --profile tailscale up -d
   ```

Your backend is now at `https://kestravault.<tailnet>.ts.net` — from any device on
your tailnet, and nowhere else.

### Option B — Tailscale already on the host

If the server itself runs Tailscale, skip the sidecar and serve the gateway
port directly:

```bash
tailscale serve --bg 8000
```

Set `API_EXTERNAL_URL`/`SITE_URL` to `https://<hostname>.<tailnet>.ts.net` and
`docker compose up -d`.

### Not recommended: public exposure

A classic reverse proxy (domain + Let's Encrypt + forwarded ports) works, but
it's real attack surface on your home network, needs a static IP or DDNS, and
fails behind CGNAT. If you go this way anyway, put the gateway behind TLS and
never expose Postgres (this compose doesn't publish 5432 at all).

## Day-2 operations

### Backups — they're your job now

There is no managed provider doing point-in-time recovery here.

```bash
./backup.sh    # pg_dump + tar of storage files → ./backups/
```

Cron it nightly. Restore instructions are in the header of `backup.sh`. Test a
restore once before you trust it — an untested backup is a hope, not a backup.

### Upgrades

```bash
git pull
docker compose pull && docker compose up -d   # newer images
./migrate.sh                                  # newer schema (no-op when current)
```

Take a backup first. Image pins mirror the official
[supabase/docker](https://github.com/supabase/supabase/tree/master/docker)
stack; if a tag fails to pull or you want newer services, lift the current
pins from there.

### Admin UI (optional)

```bash
docker compose --profile studio up -d
```

Supabase Studio on `127.0.0.1:3000` — deliberately bound to the server's
loopback only. Reach it via `ssh -L 3000:localhost:3000 you@server`, then open
http://localhost:3000. (Logs pages are blank — this stack omits the analytics
service on purpose.)

### Sleep, reboots, offline

The app is offline-first: if the server is asleep or rebooting, devices queue
their edits and the 3-way merge reconciles on reconnect. A home box that isn't
24/7 degrades to "sync happens when it's awake," not data loss.

## Troubleshooting

| Symptom                                    | Likely cause                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Sign-in redirects to `localhost` or hangs  | `API_EXTERNAL_URL`/`SITE_URL` don't match the URL you're using — fix `.env`, `docker compose up -d`              |
| `Invalid API key` from curl / the app      | Wrong anon key, or you regenerated `.env` after creating users — keys and DB must match                          |
| Realtime never connects                    | Same URL mismatch as above, or a proxy in front is dropping websockets (Tailscale Serve handles them)            |
| `db` container restart-loops on first boot | Under-provisioned RAM, or a stale half-initialized volume — `docker compose down -v` (destroys data!) and re-run |
| App can't reach the server from a phone    | The phone isn't on the tailnet, or is using the LAN URL from outside the LAN                                     |
| Emails never arrive                        | No SMTP configured — that's the default; autoconfirm is on so none are needed                                    |

Logs: `docker compose logs -f auth` (or `rest`, `realtime`, `storage`, `kong`,
`functions`, `db`).

## Security notes

- The **service_role key bypasses row-level security**. It exists in `.env`
  for the edge-functions runtime; never paste it into an app or a browser.
- `.env` is chmod 600 and gitignored. Treat it like a password file.
- On the Tailscale path, nothing is exposed to the internet: the only ways in
  are your tailnet and the host's own loopback.
- Postgres is not published to any network interface; use
  `docker compose exec db psql -U postgres` for a shell.
