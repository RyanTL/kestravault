import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Intro to Rust ownership")).toBe("intro-to-rust-ownership");
  });

  it("strips diacritics", () => {
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
  });

  it("collapses runs of separators and trims the ends", () => {
    expect(slugify("  Hello --- World!!  ")).toBe("hello-world");
  });

  it("returns an empty string when nothing is alphanumeric", () => {
    expect(slugify("!!!")).toBe("");
  });
});
