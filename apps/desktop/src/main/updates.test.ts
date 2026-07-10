import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  isNewerVersion,
  parseLatestRelease,
  parseVersion,
  LATEST_RELEASE_API,
} from "./updates.js";

describe("parseVersion", () => {
  it("parses plain and v-prefixed semver", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" v10.20.30 ")).toEqual([10, 20, 30]);
  });

  it("defaults missing minor/patch to 0", () => {
    expect(parseVersion("1")).toEqual([1, 0, 0]);
    expect(parseVersion("v1.2")).toEqual([1, 2, 0]);
  });

  it("tolerates prerelease/build suffixes without ordering on them", () => {
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+build.5")).toEqual([1, 2, 3]);
  });

  it("rejects garbage", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("v")).toBeNull();
    expect(parseVersion("1.two.3")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("orders on major, then minor, then patch", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
  });

  it("is false for equal versions (no self-update nag)", () => {
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
  });

  it("is false when either side is unparseable", () => {
    expect(isNewerVersion("0.1.0", "unknown")).toBe(false);
    expect(isNewerVersion("dev", "9.9.9")).toBe(false);
  });
});

describe("parseLatestRelease", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/RyanTL/kestravault/releases/tag/v0.2.0",
    draft: false,
    prerelease: false,
  };

  it("extracts version (without the v) and the release page URL", () => {
    expect(parseLatestRelease(release)).toEqual({
      version: "0.2.0",
      url: "https://github.com/RyanTL/kestravault/releases/tag/v0.2.0",
    });
  });

  it("rejects drafts and prereleases", () => {
    expect(parseLatestRelease({ ...release, draft: true })).toBeNull();
    expect(parseLatestRelease({ ...release, prerelease: true })).toBeNull();
  });

  it("rejects payloads missing the fields we need", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease("nope")).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ ...release, tag_name: undefined })).toBeNull();
    expect(parseLatestRelease({ ...release, html_url: 42 })).toBeNull();
  });

  it("rejects non-semver tags and non-GitHub/insecure URLs", () => {
    expect(parseLatestRelease({ ...release, tag_name: "nightly" })).toBeNull();
    expect(parseLatestRelease({ ...release, html_url: "http://github.com/x" })).toBeNull();
    expect(parseLatestRelease({ ...release, html_url: "https://evil.example/x" })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const ok = (body: unknown): Response =>
    ({ ok: true, json: () => Promise.resolve(body) }) as unknown as Response;

  it("returns the release when it is newer than the running version", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      ok({
        tag_name: "v0.2.0",
        html_url: "https://github.com/RyanTL/kestravault/releases/tag/v0.2.0",
      }),
    );
    await expect(checkForUpdate("0.1.0", fetchFn)).resolves.toEqual({
      version: "0.2.0",
      url: "https://github.com/RyanTL/kestravault/releases/tag/v0.2.0",
    });
    expect(fetchFn).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.anything());
  });

  it("returns null when already up to date", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      ok({
        tag_name: "v0.1.0",
        html_url: "https://github.com/RyanTL/kestravault/releases/tag/v0.1.0",
      }),
    );
    await expect(checkForUpdate("0.1.0", fetchFn)).resolves.toBeNull();
  });

  it("fails silently on HTTP errors (404 while the repo is private)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    await expect(checkForUpdate("0.1.0", fetchFn)).resolves.toBeNull();
  });

  it("fails silently on network errors and invalid JSON", async () => {
    await expect(
      checkForUpdate("0.1.0", vi.fn().mockRejectedValue(new Error("offline"))),
    ).resolves.toBeNull();
    const badJson = {
      ok: true,
      json: () => Promise.reject(new SyntaxError("bad json")),
    } as unknown as Response;
    await expect(checkForUpdate("0.1.0", vi.fn().mockResolvedValue(badJson))).resolves.toBeNull();
  });
});
