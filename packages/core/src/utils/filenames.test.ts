import { describe, expect, it } from "vitest";
import { sourceFilename } from "./filenames.js";

describe("sourceFilename", () => {
  it("builds a dated source filename from a date string", () => {
    expect(sourceFilename("Intro to Rust ownership", "2026-06-27")).toBe(
      "s-2026-06-27-intro-to-rust-ownership.md",
    );
  });

  it("formats a Date to YYYY-MM-DD", () => {
    expect(sourceFilename("Hello", new Date("2026-01-02T10:00:00Z"))).toBe("s-2026-01-02-hello.md");
  });
});
