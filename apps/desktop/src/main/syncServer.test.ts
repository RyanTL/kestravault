import { describe, expect, it, vi } from "vitest";
import { normalizeServerUrl, probeSyncServer } from "./syncServer.js";

// secrets.ts pulls in electron; probeSyncServer takes the key directly so these
// tests never need it, but the module import chain still must resolve.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const KEY = "test-anon-key";

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
}

describe("normalizeServerUrl", () => {
  it("accepts http(s) and strips trailing slashes", () => {
    expect(normalizeServerUrl("https://kestravault.tail1234.ts.net/")).toBe(
      "https://kestravault.tail1234.ts.net",
    );
    expect(normalizeServerUrl("http://192.168.1.50:8000//")).toBe("http://192.168.1.50:8000");
    expect(normalizeServerUrl("  https://example.com  ")).toBe("https://example.com");
  });

  it("rejects garbage, empty, and non-http schemes", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("not a url")).toBeNull();
    expect(normalizeServerUrl("ftp://example.com")).toBeNull();
    expect(normalizeServerUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("probeSyncServer", () => {
  it("fails fast without probing when the URL is invalid", async () => {
    const fetchFn = okFetch();
    const res = await probeSyncServer("nope", KEY, fetchFn);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/valid http/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails fast when no anon key is saved", async () => {
    const fetchFn = okFetch();
    const res = await probeSyncServer("https://example.com", undefined, fetchFn);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/anon key/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes auth, rest, and storage with the key on both headers", async () => {
    const fetchFn = okFetch();
    const res = await probeSyncServer("https://example.com/", KEY, fetchFn);
    expect(res.ok).toBe(true);
    expect(res.services.map((s) => s.service).sort()).toEqual(["auth", "rest", "storage"]);
    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual([
      "https://example.com/auth/v1/health",
      "https://example.com/rest/v1/",
      "https://example.com/storage/v1/status",
    ]);
    for (const [, init] of calls) {
      expect(init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    }
  });

  it("maps 401/403 to an anon-key hint and marks the result failed", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("/rest/")
        ? new Response("denied", { status: 401 })
        : new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await probeSyncServer("https://example.com", KEY, fetchFn);
    expect(res.ok).toBe(false);
    const rest = res.services.find((s) => s.service === "rest");
    expect(rest?.ok).toBe(false);
    expect(rest?.detail).toMatch(/anon key/);
    expect(res.services.filter((s) => s.ok)).toHaveLength(2);
  });

  it("survives a network error on one service without rejecting", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/storage/")) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await probeSyncServer("https://example.com", KEY, fetchFn);
    expect(res.ok).toBe(false);
    expect(res.services.find((s) => s.service === "storage")?.detail).toBe("network error");
  });
});
