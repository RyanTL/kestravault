/**
 * Breached-password check against the HaveIBeenPwned "Pwned Passwords" range
 * API (https://haveibeenpwned.com/API/v3#PwnedPasswords) using k-anonymity:
 * only the first 5 hex characters of the password's SHA-1 ever leave the
 * machine, and the response is a bucket of ~800 suffixes we match locally.
 * The request also asks for response padding, so the bucket size leaks
 * nothing either. Built on Web Crypto + fetch, so the module stays
 * platform-agnostic.
 *
 * Fail-open by design: if the API is unreachable or answers with an error,
 * the result is `checked: false` / `breached: false` — an HIBP outage must
 * never block someone from creating an account.
 */

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

export interface LeakedPasswordResult {
  /** True when the password appears in a known breach corpus. */
  breached: boolean;
  /** How many times it appears (0 when not found or unchecked). */
  count: number;
  /** False when the API could not be consulted (network error, non-2xx). */
  checked: boolean;
}

async function sha1HexUpper(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

export async function checkLeakedPassword(
  password: string,
  fetchFn: typeof fetch = fetch,
): Promise<LeakedPasswordResult> {
  const hash = await sha1HexUpper(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  let body: string;
  try {
    const res = await fetchFn(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!res.ok) return { breached: false, count: 0, checked: false };
    body = await res.text();
  } catch {
    return { breached: false, count: 0, checked: false };
  }

  // Response lines are "SUFFIX:COUNT". Padding entries carry count 0 and
  // must not read as breaches.
  for (const line of body.split(/\r?\n/)) {
    const [lineSuffix, countText] = line.split(":");
    if (lineSuffix?.trim().toUpperCase() !== suffix) continue;
    const count = Number.parseInt(countText ?? "0", 10) || 0;
    return { breached: count > 0, count, checked: true };
  }
  return { breached: false, count: 0, checked: true };
}
