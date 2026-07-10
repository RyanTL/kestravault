# Self-Hosting

_Drafted 2026-07-03; **built 2026-07-03** (same day — see "What shipped" below). How someone runs the whole stack themselves. Self-hosting is already **allowed and license-supported** (MIT since 2026-07-09) ([sync-collab-open-core.md](sync-collab-open-core.md): one AGPLv3 repo, backend included, Cal.com-style) — this doc turns "permitted" into "paved," with the **Tailscale path** as the blessed way to reach a **home server**._

## What shipped (2026-07-03)

- **`selfhost/`** — a slim Supabase compose stack (db/kong/auth/rest/realtime/storage/imgproxy/functions; `--profile studio` for the admin UI, `--profile tailscale` for a sidecar that Tailscale-Serves the gateway over HTTPS at a MagicDNS name), plus `setup.sh` (generates `.env`: passwords + HS256-signed anon/service JWTs, openssl-only), `migrate.sh` (idempotent, CLI-convention tracking table), `backup.sh` (pg_dump + storage tar), and a full [README](../selfhost/README.md) covering the Tailscale path, LAN mode, min specs (4 GB+, amd64/arm64), backups, upgrades, troubleshooting.
- **Desktop Settings → Sync server** — server URL (persisted settings) + anon key (encrypted secret store, id `sync-server`, write-only IPC like BYOK keys) + **Test connection** probing auth/rest/storage through the gateway (`apps/desktop/src/main/syncServer.ts`, unit-tested).
- **Caveats:** compose is modeled on the official supabase/docker stack but has **not yet been smoke-tested with a real `docker compose up`** (no Docker on the dev machine) — do that before announcing; image pins may need bumping. The sync _engine_ itself is still the planned Phase-0/1 work — the field verifies and stores the connection so self-host is ready the day sync lands.

> **One line.** Ship a `docker compose up` for the in-repo Supabase backend, add a "connect to your own server" field to the app, and document **Tailscale** as the access layer — so a technical user can self-host multi-device sync on a box at home in an afternoon, with no domain, no open ports, and free TLS.

## Why this exists

The whole backend is public and in-repo (`supabase/` — schema, RLS, edge functions). The AGPLv3 / Cal.com bet is deliberate: **anyone _may_ self-host; almost nobody _will_, because ~$15/mo beats running Postgres yourself** ([sync-collab-open-core.md §4](sync-collab-open-core.md)). That bet only holds if self-hosting is genuinely _possible_ — a paved path for the minority who want it is what makes the "we're really open" claim credible. It is a **credibility and community feature, not a revenue path.** Keep the effort proportional: pave the road, don't gold-plate it.

## Three things people mean by "self-host"

| Tier                            | What runs                                                       | Server?             | Networking                  | Status                                            |
| ------------------------------- | --------------------------------------------------------------- | ------------------- | --------------------------- | ------------------------------------------------- |
| **0 — Local-only**              | One machine, vault on disk, BYO-model AI. No account.           | None                | None                        | ✅ Ships today ([roadmap.md](roadmap.md) Phase 0) |
| **1 — Home-server sync**        | Own Supabase → laptop + phone + (later) other people sync to it | Yes — a box at home | **Tailscale** (recommended) | ✅ Packaged (`selfhost/`, 2026-07-03)             |
| **2 — Full self-host incl. AI** | Tier 1 **+** the agent running on the user's own key            | Yes                 | Tailscale                   | ⛔ Blocked on the portable agent loop (below)     |

Tier 0 already exists and needs nothing here. **This doc is about Tier 1** (the realistic target) and names Tier 2's blocker honestly.

## What is and isn't self-hostable

- **Supabase (Postgres, auth, storage, realtime)** — ✅ self-hostable via the official docker-compose stack. Our migrations/RLS/edge functions apply on top.
- **Stripe / billing / entitlements** — irrelevant self-hosted; the entitlement checks must **no-op** (a self-host build has no "owner has a paid plan" gate — every workspace is enabled). Small but required code change.
- **Anthropic Managed Agents** — ❌ **cannot** run on someone's home server or tailnet. The self-host AI path is the **portable BYO-key agent loop** (Claude API / any-provider tool-use loop, the `preset.local` seam already in desktop BYO-model settings — see [architecture.md](architecture.md) "Local / self-host runtime" and [roadmap.md](roadmap.md) Post-MVP). **It is not built yet.** Until it lands, a self-hoster gets **sync + BYO-model chat** but **not the autonomous cloud agent** that maintains the wiki. This is the single most important honest limitation to state up front.

## The keystone: a "connect to your own server" field — ✅ SHIPPED 2026-07-03

Nothing else matters without this; it now exists as **Settings → Sync server** (server URL + anon key + Test connection). `packages/core`'s client was already fully configurable (`createSupabaseClient({url, key})` — SH1), so no core refactor was needed. The Stripe entitlement no-op stays trivially true for now (billing isn't built yet); when billing lands, a configured custom server must skip the entitlement gate.

- The field lives in its own Settings tab, clearly framed as self-host — out of the way of the 99% who'll use the hosted service.

## Home-server realities (design around these)

A "home server" is a Synology/Unraid NAS, a mini-PC, an old laptop, or a Raspberry Pi. That population has specific constraints the hosted service never faces:

- **Hardware footprint.** The full Supabase stack is ~10 containers (Postgres, Kong, GoTrue, PostgREST, Realtime, Storage, imgproxy, postgres-meta, Studio, analytics). It is **memory-hungry** — budget **4 GB+ RAM**; a 2 GB Pi is not enough. Document a **minimum spec** and, ideally, a **slim compose** that drops Studio + analytics for headless sync-only use.
- **CPU arch.** Publish/verify **arm64** works (Apple Silicon, modern Pi 4/5, ARM NAS), not just x86 — home servers are often ARM.
- **No static IP / behind CGNAT.** Most home internet has a dynamic IP and is behind carrier NAT — you **cannot** reliably port-forward. This is precisely why **Tailscale is the recommendation, not one option among many**: WireGuard mesh works through NAT/CGNAT with zero port forwarding.
- **Backups are now the user's job.** No managed provider doing point-in-time recovery. Ship a one-command **`pg_dump` + storage-volume backup** script and say plainly: _self-hosting means you own your backups._
- **Uptime / sleep.** A home box may sleep or reboot. The sync engine already handles offline/queue + 3-way merge ([architecture.md](architecture.md)), so clients just catch up on reconnect — no special handling needed, but call it out so users don't expect 24/7.

## The Tailscale path (recommended)

Tailscale collapses the hardest parts of self-hosting — secure remote access + TLS — into near-zero config, and directly answers the CGNAT/dynamic-IP problem above.

- **Reachability.** Devices reach the server over WireGuard at a stable **MagicDNS** name (`server.tailnet.ts.net`) — no domain, no open ports, no DDNS.
- **Free real TLS.** **Tailscale Serve** (or `tailscale cert`) fronts the Supabase **Kong** gateway with a valid HTTPS cert automatically. This matters because auth, Realtime (WSS), and secure-context browser APIs all want HTTPS — normally the worst part of Supabase self-host, erased here.
- **The load-bearing gotcha.** Supabase bakes the external URL into GoTrue/Realtime/Storage. **`API_EXTERNAL_URL` / `SITE_URL` (and GoTrue redirect URLs) must be set to the MagicDNS name**, or auth redirects and realtime silently break. The docs must hand over a copy-paste `.env` keyed to `https://<host>.<tailnet>.ts.net`.
- **Mobile.** The Expo/RN app on a phone that's on the tailnet reaches the same MagicDNS name — install Tailscale on the phone, done. No other VPN config.
- **Optional polish — a `tailscale` sidecar** in the compose that joins the tailnet via `TS_AUTHKEY` and Tailscale-Serves Kong, so `docker compose up` yields a private, TLS-terminated backend with no manual cert/proxy step.

## Alternatives (documented, not recommended)

- **LAN-only** — same-house access, no Tailscale. Simplest, but no phone sync when you leave home. Fine as a starter.
- **Public ingress** (domain + reverse proxy + Let's Encrypt + port forwarding) — the traditional path. **Discouraged**: more attack surface, needs a static IP or DDNS, breaks behind CGNAT. Mention it exists; steer people to Tailscale.

## Make-it-easy — phased

1. ✅ **Custom-server field** in the app (+ entitlement no-op). _The keystone; everything depends on it._ — Settings → Sync server, 2026-07-03.
2. ✅ **`docker-compose.yml` + migrate script** — bundled in `selfhost/` with our migrations applied by `migrate.sh`; the stack is slim by default (no Studio/analytics; Studio is an opt-in profile). 2026-07-03.
3. ✅ **Tailscale setup doc** — [selfhost/README.md](../selfhost/README.md): MagicDNS + Tailscale Serve + the `API_EXTERNAL_URL` gotcha, backup script, min-spec/arm64 notes. 2026-07-03.
4. ✅/— **(Polish)** the Tailscale **sidecar container shipped too** (`--profile tailscale`); an in-app wizard remains future polish.
5. ⛔ **(Unblocks Tier 2 AI)** the portable BYO-key agent loop — already roadmapped ([roadmap.md](roadmap.md) Post-MVP). Self-hosters get the full agent only once this lands.

**Was the recommendation, now done:** 1 + 2 + 3 (+ most of 4) shipped as the "self-host preview." Outstanding: a real `docker compose up` smoke test on a Docker machine before announcing; the agent loop (5) stays the stated limitation.

## Open questions

- **SH1 — Custom-server field feasibility. ANSWERED 2026-07-03:** `packages/core`'s client was already fully configurable (`createSupabaseClient({url, key})`, nothing hardcoded); the desktop field shipped same-day (Settings → Sync server).
- **SH2 — How much do we support it?** "Community-supported, best-effort, issues welcome" vs a maintained tested path. Proportional-effort says the former at first. Relates to O10 (AWS-native migration is a _different_ self-host axis — that's ops for _our_ SaaS, this is ops for _the user's_ box).
- **SH3 — Slim compose scope.** Which services can safely be dropped for sync-only (Studio? analytics/Logflare?) without breaking auth/storage/realtime?
- **SH4 — Version skew.** Self-hosters run whatever backend version they pulled; the app may move ahead. Migration/compatibility policy for self-hosted backends.
- **SH5 — Shared workspaces self-hosted.** Feature A (up to 4: owner + 3, [sync-collab-open-core.md §2](sync-collab-open-core.md)) on a home server drops the Stripe entitlement entirely — the box _is_ the entitlement. Confirm RLS-by-membership works standalone with billing no-op'd.
