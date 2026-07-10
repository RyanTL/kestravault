import { app, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

// ── Secret storage ───────────────────────────────────────────────────────────
// BYOK API keys live HERE — in the main process, encrypted at rest with the OS
// keychain via Electron's safeStorage (Keychain on macOS, libsecret on Linux,
// DPAPI on Windows). The renderer can store and clear a key, and ask whether one
// exists, but can never read a key back: plaintext keys never cross the IPC
// boundary or touch localStorage. ai.ts resolves the key by provider id at the
// moment of a request.
//
// On-disk layout (userData/secrets.json), one entry per provider id:
//   { "anthropic": { "enc": "<base64>" }, "openai": { "plain": "sk-…" } }
// `enc` is safeStorage ciphertext; `plain` is the honest fallback used only when
// no OS keychain is available (e.g. a headless Linux box) — see writeStore().

type SecretEntry = { enc: string } | { plain: string };
type SecretStore = Record<string, SecretEntry>;

let store: SecretStore | null = null;

function secretsFile(): string {
  return join(app.getPath("userData"), "secrets.json");
}

function loadStore(): SecretStore {
  if (store) return store;
  try {
    const raw = readFileSync(secretsFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    store = isStore(parsed) ? parsed : {};
  } catch {
    // Missing or corrupt file — start clean.
    store = {};
  }
  return store;
}

function isStore(v: unknown): v is SecretStore {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(
    (e) =>
      !!e &&
      typeof e === "object" &&
      (typeof (e as { enc?: unknown }).enc === "string" ||
        typeof (e as { plain?: unknown }).plain === "string"),
  );
}

// Persist the store with owner-only permissions (0600) so a stray plaintext
// fallback isn't world-readable.
async function writeStore(): Promise<void> {
  if (!store) return;
  const file = secretsFile();
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // chmod is unsupported on some filesystems (e.g. Windows) — non-fatal.
  }
}

/** True when the OS keychain is available to encrypt secrets at rest. */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Store (or, with an empty value, delete) a provider's API key. */
export async function setSecret(providerId: string, key: string): Promise<void> {
  if (!providerId) return;
  const s = loadStore();
  const trimmed = key.trim();
  if (!trimmed) {
    delete s[providerId];
    await writeStore();
    return;
  }
  if (encryptionAvailable()) {
    s[providerId] = { enc: safeStorage.encryptString(trimmed).toString("base64") };
  } else {
    // No keychain: keep the key working rather than silently dropping it, but
    // the file is 0600 and the UI warns the user it isn't encrypted.
    s[providerId] = { plain: trimmed };
  }
  await writeStore();
}

/** Resolve a provider's key for an outgoing request. Main-process only. */
export function getSecret(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  const entry = loadStore()[providerId];
  if (!entry) return undefined;
  if ("plain" in entry) return entry.plain;
  try {
    return safeStorage.decryptString(Buffer.from(entry.enc, "base64"));
  } catch {
    // Ciphertext we can't decrypt (e.g. moved machines / keychain reset).
    return undefined;
  }
}

/** Provider ids that currently have a key saved — safe to expose to the UI. */
export function listSecretIds(): string[] {
  return Object.keys(loadStore());
}

// A short, non-reversible fingerprint of a provider's key, for cache keys that
// must change when the key value changes (without logging the key itself).
export function keyFingerprint(providerId: string | undefined): string {
  const key = getSecret(providerId);
  if (!key) return "";
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Whether the secrets file already exists (used to gate one-time migration). */
export function secretsFileExists(): boolean {
  return existsSync(secretsFile());
}
