import { describe, expect, it } from "vitest";
import {
  brainContext,
  buildAgentsMd,
  buildClaudeMd,
  buildInstructions,
  defaultProfile,
  enhancePrompt,
  looksLikeInstructions,
  scaffoldDirs,
  type BrainProfile,
} from "./brain";

const profile = (patch: Partial<BrainProfile> = {}): BrainProfile => ({
  ...defaultProfile(),
  ...patch,
});

describe("buildInstructions — the personalized schema", () => {
  it("folds the onboarding answers into the schema", () => {
    const text = buildInstructions(
      profile({
        purpose: "reading",
        topics: "Tolkien's legendarium",
        about: "History teacher",
        style: "detailed",
        language: "Spanish",
        ingestMode: "auto",
        categories: ["books", "characters"],
      }),
      "My Vault",
    );
    expect(text).toContain("# My Vault — Brain instructions");
    expect(text).toContain("Reading companion");
    expect(text).toContain("Tolkien's legendarium");
    expect(text).toContain("History teacher");
    expect(text).toContain("`wiki/books/`");
    expect(text).toContain("`wiki/characters/`");
    expect(text).toContain("Spanish");
    expect(text).toContain("Auto mode");
    expect(text).toContain("well-developed prose");
  });

  it("always carries the zone permissions and the improve-over-time hooks", () => {
    const text = buildInstructions(profile(), "V");
    expect(text).toContain("read-only — never modify or delete"); // sources/
    expect(text).toContain("## Learned preferences");
    expect(text).toContain("Never edit this file yourself");
    expect(looksLikeInstructions(text)).toBe(true);
  });
});

describe("portability stubs", () => {
  it("AGENTS.md points every agent at the instructions file", () => {
    const text = buildAgentsMd("My Vault");
    expect(text).toContain(".kestravault/instructions.md");
    expect(text).toContain("`sources/` is immutable");
  });

  it("CLAUDE.md defers to AGENTS.md (one shared ruleset)", () => {
    expect(buildClaudeMd()).toContain("AGENTS.md");
  });
});

describe("scaffoldDirs", () => {
  it("builds the three zones plus the chosen wiki categories", () => {
    expect(scaffoldDirs(profile({ categories: ["concepts", "people"] }))).toEqual([
      "sources",
      "sources/assets",
      "wiki/concepts",
      "wiki/people",
      "notes",
    ]);
  });
});

describe("AI personalization plumbing", () => {
  it("enhancePrompt carries the answers and the template", () => {
    const p = profile({ topics: "biotech" });
    const text = enhancePrompt(p, "TEMPLATE-BODY");
    expect(text).toContain("biotech");
    expect(text).toContain("TEMPLATE-BODY");
  });

  it("looksLikeInstructions rejects chatty/failed output", () => {
    expect(looksLikeInstructions("Sorry, I can't do that.")).toBe(false);
    expect(looksLikeInstructions("# Title\nbut too short")).toBe(false);
  });

  it("brainContext embeds and truncates the instructions", () => {
    expect(brainContext("")).toBe("");
    const ctx = brainContext("# Rules\nBe nice.");
    expect(ctx).toContain("Be nice.");
    const long = brainContext("#" + "x".repeat(10_000));
    expect(long.length).toBeLessThan(7_000);
  });
});
