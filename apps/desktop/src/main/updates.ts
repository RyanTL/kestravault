// Update notifications (v1: notify-and-manual-download, no auto-install).
//
// The main process polls the GitHub releases API on launch and every ~24h,
// compares the latest tag against the running version, and tells the renderer
// when something newer exists. The renderer shows a banner whose button opens
// the release page in the default browser — nothing is downloaded or installed
// by the app itself. The whole feature sits behind a settings toggle: when off,
// the renderer never enables the checker and zero network calls are made.
//
// Until the repo goes public the API returns 404; every failure path here
// (404, rate limit, offline, bad payload) resolves to "no update" silently.

/** A newer release the user can go download. */
export interface UpdateInfo {
  /** Version of the latest release, without the leading `v`. */
  version: string;
  /** GitHub release page to open in the browser. */
  url: string;
}

export const LATEST_RELEASE_API = "https://api.github.com/repos/RyanTL/kestravault/releases/latest";

/** How often to re-check while the app stays open. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse `"v1.2.3"` / `"1.2.3"` into a numeric triple. Anything that doesn't
 * lead with `major.minor.patch` (missing parts default to 0) returns null.
 * Prerelease/build suffixes (`-beta.1`, `+abc`) are tolerated but ignored —
 * releases are tagged as plain versions, so suffix ordering never decides.
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Whether `latest` is strictly newer than `current`. Unparseable → false. */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i]! !== a[i]!) return b[i]! > a[i]!;
  }
  return false;
}

/**
 * Extract the release version + page URL from a `releases/latest` API payload.
 * Defensive: the body is untrusted JSON, so require the exact shapes we use
 * and only accept https URLs on github.com. Drafts/prereleases are rejected
 * (the `latest` endpoint shouldn't return them, but don't rely on it).
 */
export function parseLatestRelease(body: unknown): UpdateInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const rel = body as Record<string, unknown>;
  if (rel.draft === true || rel.prerelease === true) return null;
  const tag = rel.tag_name;
  const url = rel.html_url;
  if (typeof tag !== "string" || typeof url !== "string") return null;
  if (!parseVersion(tag)) return null;
  if (!/^https:\/\/github\.com\//.test(url)) return null;
  return { version: tag.replace(/^v/, ""), url };
}

/**
 * One check against the releases API. Resolves to the newer release, or null
 * for "nothing newer" AND every failure mode — update checking must never
 * surface an error to the user.
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchFn: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  try {
    const res = await fetchFn(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null; // 404 while private, 403 rate limit, 5xx…
    const info = parseLatestRelease(await res.json());
    if (!info || !isNewerVersion(currentVersion, info.version)) return null;
    return info;
  } catch {
    return null; // offline, DNS failure, invalid JSON…
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────
// Electron-free on purpose (index.ts passes the version in and a notify
// callback out) so this whole module unit-tests in plain Node.

let timer: NodeJS.Timeout | null = null;

/** Stop the periodic check. Idempotent. */
export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Start checking now and every {@link CHECK_INTERVAL_MS}; `notify` fires only
 * when a newer release exists. Restarting replaces any previous schedule.
 */
export function startUpdateChecks(
  currentVersion: string,
  notify: (info: UpdateInfo) => void,
  fetchFn: typeof fetch = fetch,
): void {
  stopUpdateChecks();
  const run = async (): Promise<void> => {
    const info = await checkForUpdate(currentVersion, fetchFn);
    if (info && timer) notify(info);
  };
  timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
  void run();
}
