import type { Sha256 } from "../types/ids.js";

/**
 * Lowercase-hex SHA-256 of a UTF-8 string — the canonical content fingerprint
 * carried on `files.sha256` / `file_versions.sha256` and used by the sync
 * engine to detect local edits. Built on Web Crypto (`crypto.subtle`), which is
 * available on every target we run on (browsers, Node 20+, RN with a polyfill),
 * so the module stays platform-agnostic.
 */
export async function sha256Hex(text: string): Promise<Sha256> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
