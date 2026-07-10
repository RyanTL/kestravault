// Crockford base32 (excludes I, L, O, U to avoid ambiguity).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(time: number): string {
  let value = time;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(value % ENCODING_LEN) + out;
    value = Math.floor(value / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(): string {
  let out = "";
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    out += ENCODING.charAt(byte % ENCODING_LEN);
  }
  return out;
}

/**
 * Generate a ULID — a 26-char, lexicographically sortable, collision-resistant
 * id. The first 10 chars encode `seedTime` (ms since epoch), so ids created
 * later sort after earlier ones; the last 16 are cryptographic randomness.
 *
 * `seedTime` is injectable for deterministic tests.
 */
export function ulid(seedTime: number = Date.now()): string {
  return encodeTime(seedTime) + encodeRandom();
}
