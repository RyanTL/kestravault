import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Mutable knobs shared with the hoisted `electron` mock below. Tests flip these
// to simulate "keychain present" vs. "headless box with no keychain", and to
// point the store at a throwaway temp dir.
const env = vi.hoisted(() => ({
  userDataDir: "",
  encryptionAvailable: true,
  isAvailableThrows: false,
}));

// A fake of just the two Electron surfaces secrets.ts touches. encryptString /
// decryptString are a reversible "ENC(…)" wrapper so the real encrypt→base64→
// decrypt round-trip in the module is exercised end to end; decryptString
// throws on anything it didn't produce, mirroring a failed real decrypt.
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return env.userDataDir;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      if (env.isAvailableThrows) throw new Error("keychain blew up");
      return env.encryptionAvailable;
    },
    encryptString: (s: string) => Buffer.from(`ENC(${s})`, "utf8"),
    decryptString: (buf: Buffer) => {
      const m = /^ENC\(([\s\S]*)\)$/.exec(buf.toString("utf8"));
      if (!m) throw new Error("cannot decrypt");
      return m[1]!;
    },
  },
}));

// Fresh import of the module under test, so its module-level store cache starts
// empty. `beforeEach` resets the registry, so each call re-reads from disk.
async function freshSecrets() {
  return import("./secrets.js");
}

function storeFile(): string {
  return join(env.userDataDir, "secrets.json");
}

beforeEach(() => {
  env.userDataDir = mkdtempSync(join(tmpdir(), "kestravault-secrets-"));
  env.encryptionAvailable = true;
  env.isAvailableThrows = false;
  vi.resetModules();
});

afterEach(() => {
  rmSync(env.userDataDir, { recursive: true, force: true });
});

describe("secrets — with an OS keychain available", () => {
  it("encrypts at rest and round-trips a key", async () => {
    const s = await freshSecrets();
    expect(s.encryptionAvailable()).toBe(true);

    await s.setSecret("anthropic", "sk-ant-secret");
    expect(s.getSecret("anthropic")).toBe("sk-ant-secret");

    // On disk it's ciphertext under `enc`, never the plaintext key.
    const raw = readFileSync(storeFile(), "utf8");
    expect(raw).not.toContain("sk-ant-secret");
    const parsed = JSON.parse(raw) as Record<string, { enc?: string; plain?: string }>;
    expect(typeof parsed.anthropic?.enc).toBe("string");
    expect(parsed.anthropic?.plain).toBeUndefined();
  });

  it("trims the key before storing", async () => {
    const s = await freshSecrets();
    await s.setSecret("anthropic", "  sk-ant-trim  ");
    expect(s.getSecret("anthropic")).toBe("sk-ant-trim");
  });

  it("deletes a provider when set to an empty or whitespace value", async () => {
    const s = await freshSecrets();
    await s.setSecret("openai", "sk-openai");
    expect(s.listSecretIds()).toContain("openai");

    await s.setSecret("openai", "   ");
    expect(s.getSecret("openai")).toBeUndefined();
    expect(s.listSecretIds()).not.toContain("openai");
  });

  it("ignores an empty provider id", async () => {
    const s = await freshSecrets();
    await s.setSecret("", "whatever");
    expect(s.listSecretIds()).toEqual([]);
  });

  it("returns undefined for unknown or undefined providers", async () => {
    const s = await freshSecrets();
    expect(s.getSecret(undefined)).toBeUndefined();
    expect(s.getSecret("nope")).toBeUndefined();
  });

  it("lists exactly the provider ids that have a key", async () => {
    const s = await freshSecrets();
    await s.setSecret("anthropic", "a");
    await s.setSecret("openai", "b");
    expect(s.listSecretIds().sort()).toEqual(["anthropic", "openai"]);
  });

  it("returns undefined for ciphertext it cannot decrypt", async () => {
    // Simulate keychain reset / moved machine: stored `enc` is not ours.
    writeFileSync(
      storeFile(),
      JSON.stringify({ anthropic: { enc: Buffer.from("garbage").toString("base64") } }),
    );
    const s = await freshSecrets();
    expect(s.getSecret("anthropic")).toBeUndefined();
  });
});

describe("secrets — no keychain (plaintext fallback)", () => {
  beforeEach(() => {
    env.encryptionAvailable = false;
  });

  it("reports encryption unavailable", async () => {
    const s = await freshSecrets();
    expect(s.encryptionAvailable()).toBe(false);
  });

  it("stores the key as plaintext and still resolves it", async () => {
    const s = await freshSecrets();
    await s.setSecret("openai", "sk-plain");
    expect(s.getSecret("openai")).toBe("sk-plain");

    const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as Record<string, unknown>;
    expect(parsed.openai).toEqual({ plain: "sk-plain" });
  });

  it("reports encryption unavailable when safeStorage throws", async () => {
    env.isAvailableThrows = true;
    const s = await freshSecrets();
    expect(s.encryptionAvailable()).toBe(false);
    // And setSecret falls back to plaintext rather than crashing.
    await s.setSecret("openai", "sk-plain");
    expect(s.getSecret("openai")).toBe("sk-plain");
  });
});

describe("secrets — persistence and on-disk hygiene", () => {
  it("persists across a module reload by reading the file back", async () => {
    const first = await freshSecrets();
    await first.setSecret("anthropic", "persisted");

    // New module instance, same userData dir → must read from disk, not cache.
    vi.resetModules();
    const second = await freshSecrets();
    expect(second.getSecret("anthropic")).toBe("persisted");
  });

  it("reports whether the secrets file exists", async () => {
    const s = await freshSecrets();
    expect(s.secretsFileExists()).toBe(false);
    await s.setSecret("anthropic", "a");
    expect(s.secretsFileExists()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "writes the secrets file with owner-only (0600) permissions",
    async () => {
      const s = await freshSecrets();
      await s.setSecret("anthropic", "a");
      expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
    },
  );

  it("starts clean when the secrets file is corrupt, and stays writable", async () => {
    writeFileSync(storeFile(), "{ not valid json");
    const s = await freshSecrets();
    expect(s.listSecretIds()).toEqual([]);

    await s.setSecret("anthropic", "a");
    expect(s.getSecret("anthropic")).toBe("a");
  });

  it("ignores a secrets file whose entries have the wrong shape", async () => {
    writeFileSync(storeFile(), JSON.stringify({ anthropic: { nope: 1 } }));
    const s = await freshSecrets();
    expect(s.listSecretIds()).toEqual([]);
  });
});

describe("secrets — keyFingerprint", () => {
  it("is empty when there is no key", async () => {
    const s = await freshSecrets();
    expect(s.keyFingerprint("anthropic")).toBe("");
    expect(s.keyFingerprint(undefined)).toBe("");
  });

  it("is a stable 12-char sha256 prefix that never leaks the key", async () => {
    const s = await freshSecrets();
    await s.setSecret("anthropic", "key-one");

    const fp = s.keyFingerprint("anthropic");
    const expected = createHash("sha256").update("key-one").digest("hex").slice(0, 12);
    expect(fp).toBe(expected);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).not.toContain("key-one");
  });

  it("changes when the key value changes", async () => {
    const s = await freshSecrets();
    await s.setSecret("anthropic", "key-one");
    const before = s.keyFingerprint("anthropic");
    await s.setSecret("anthropic", "key-two");
    expect(s.keyFingerprint("anthropic")).not.toBe(before);
  });
});
