import { describe, expect, it, vi } from "vitest";
import { checkLeakedPassword } from "./leaked-password.js";

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PREFIX = "5BAA6";
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

function fetchReturning(body: string, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe("checkLeakedPassword", () => {
  it("flags a password whose suffix is in the range response", async () => {
    const fetchFn = fetchReturning(
      `0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${SUFFIX}:42\r\nFFFFF00000000000000000000000000000F:1`,
    );
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result).toEqual({ breached: true, count: 42, checked: true });
  });

  it("sends only the 5-char SHA-1 prefix, never the password", async () => {
    const fetchFn = fetchReturning("");
    await checkLeakedPassword("password", fetchFn);
    const url = String(vi.mocked(fetchFn).mock.calls[0]?.[0]);
    // The exact match proves only the prefix is sent — no suffix, no password.
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    expect(url).not.toContain(SUFFIX);
  });

  it("passes a clean password", async () => {
    const fetchFn = fetchReturning("0018A45C4D1DEF81644B54AB7F969B88D65:3");
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result).toEqual({ breached: false, count: 0, checked: true });
  });

  it("matches suffixes case-insensitively", async () => {
    const fetchFn = fetchReturning(`${SUFFIX.toLowerCase()}:7`);
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result.breached).toBe(true);
  });

  it("ignores zero-count padding entries", async () => {
    const fetchFn = fetchReturning(`${SUFFIX}:0`);
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result).toEqual({ breached: false, count: 0, checked: true });
  });

  it("fails open when the request throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result).toEqual({ breached: false, count: 0, checked: false });
  });

  it("fails open on a non-2xx response", async () => {
    const fetchFn = fetchReturning("", false);
    const result = await checkLeakedPassword("password", fetchFn);
    expect(result).toEqual({ breached: false, count: 0, checked: false });
  });
});
