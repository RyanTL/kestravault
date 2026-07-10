import { describe, expect, it } from "vitest";
import { ulid } from "./ulid.js";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts by creation time via the timestamp prefix", () => {
    const earlier = ulid(1_000);
    const later = ulid(2_000);
    expect(earlier < later).toBe(true);
  });

  it("does not collide across many calls", () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => ulid()));
    expect(ids.size).toBe(1_000);
  });
});
