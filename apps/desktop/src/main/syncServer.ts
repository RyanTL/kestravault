import { getSecret } from "./secrets.js";

// ── Sync server (self-host) ──────────────────────────────────────────────────
// Users who run their own backend (see selfhost/README.md) point the app at it
// with a server URL + anon key. This module owns the "Test connection" probe:
// it hits the health endpoints of the three services the sync engine will rely
// on (auth, rest, storage) through the server's API gateway. The anon key is
// stored via secrets.ts under SYNC_SERVER_SECRET_ID — same encrypted store and
// write-only IPC surface as the BYOK provider keys.

/** Secret-store id for the sync server's anon key (also mirrored in the renderer). */
export const SYNC_SERVER_SECRET_ID = "sync-server";

export type SyncService = "auth" | "rest" | "storage";

export interface SyncServiceStatus {
  service: SyncService;
  ok: boolean;
  /** Short human-readable failure reason (present when !ok). */
  detail?: string;
}

export interface SyncTestResult {
  /** True when every probed service answered healthy. */
  ok: boolean;
  services: SyncServiceStatus[];
  /** Top-level failure (bad URL / missing key) when we couldn't probe at all. */
  detail?: string;
}

/** Validate + canonicalize a user-typed server URL (origin only, no trailing /). */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

// The gateway paths that answer cheaply when each service is alive. Kong
// requires the anon key (apikey header) on auth + rest; storage checks status
// unauthenticated behind /storage/v1.
const PROBES: { service: SyncService; path: string }[] = [
  { service: "auth", path: "/auth/v1/health" },
  { service: "rest", path: "/rest/v1/" },
  { service: "storage", path: "/storage/v1/status" },
];

const PROBE_TIMEOUT_MS = 8_000;

function describeHttp(status: number): string {
  if (status === 401 || status === 403) return "unauthorized — is the anon key right?";
  if (status === 404) return "not found — is this a Supabase/KestraVault gateway URL?";
  return `HTTP ${status}`;
}

async function probeOne(
  base: string,
  path: string,
  key: string,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetchFn(`${base}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, detail: describeHttp(res.status) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, detail: aborted ? "timed out — server unreachable?" : "network error" };
  }
}

/**
 * Probe a self-hosted server. Pure of Electron state: the key and fetch are
 * injectable so tests never touch the real secret store or network.
 */
export async function probeSyncServer(
  rawUrl: string,
  key: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<SyncTestResult> {
  const base = normalizeServerUrl(rawUrl);
  if (!base) {
    return { ok: false, services: [], detail: "Enter a valid http(s) server URL." };
  }
  if (!key) {
    return { ok: false, services: [], detail: "Save your server's anon key first." };
  }
  const services = await Promise.all(
    PROBES.map(async ({ service, path }) => {
      const r = await probeOne(base, path, key, fetchFn);
      return { service, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) };
    }),
  );
  return { ok: services.every((s) => s.ok), services };
}

/** IPC entry point: resolve the stored anon key, then probe. */
export function testSyncServer(rawUrl: string): Promise<SyncTestResult> {
  return probeSyncServer(rawUrl, getSecret(SYNC_SERVER_SECRET_ID));
}
