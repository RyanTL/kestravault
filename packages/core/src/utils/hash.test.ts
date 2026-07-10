import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes UTF-8 code points, not UTF-16 units", async () => {
    // "é" is two bytes in UTF-8; a UTF-16 implementation would differ.
    expect(await sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });

  it("is deterministic and collision-distinct for different inputs", async () => {
    expect(await sha256Hex("same")).toBe(await sha256Hex("same"));
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});
