import { describe, expect, it } from "vitest";
import {
  brainContext,
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

describe("buildInstructions — the personalized AI guide", () => {
  it("folds the onboarding answers into the guide", () => {
    const text = buildInstructions(
      profile({
        purpose: "reading",
        topics: "Tolkien's legendarium",
        about: "History teacher",
        style: "detailed",
        language: "Spanish",
        ingestMode: "auto",
        folders: ["reading", "notes"],
      }),
      "My Vault",
    );
    expect(text).toContain("# My Vault — AI guide");
    expect(text).toContain("Reading companion");
    expect(text).toContain("Tolkien's legendarium");
    expect(text).toContain("History teacher");
    expect(text).toContain("`reading/`");
    expect(text).toContain("`notes/`");
    expect(text).toContain("Spanish");
    expect(text).toContain("summarize what changed");
    expect(text).toContain("well-developed prose");
  });

  it("always carries the vault map (the index) and the improve-over-time hooks", () => {
    const text = buildInstructions(profile(), "V");
    expect(text).toContain("## Vault map");
    expect(text).toContain("update the Vault map");
    expect(text).toContain("## Learned preferences");
    expect(text).toContain("moving or renaming notes over deleting");
    expect(looksLikeInstructions(text)).toBe(true);
  });
});

describe("scaffoldDirs", () => {
  it("creates exactly the folders the user picked", () => {
    expect(scaffoldDirs(profile({ folders: ["projects", "people"] }))).toEqual([
      "projects",
      "people",
    ]);
  });

  it("falls back to a single notes folder when nothing was picked", () => {
    expect(scaffoldDirs(profile({ folders: [] }))).toEqual(["notes"]);
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

  it("brainContext embeds and truncates the guide", () => {
    expect(brainContext("")).toBe("");
    const ctx = brainContext("# Rules\nBe nice.");
    expect(ctx).toContain("Be nice.");
    const long = brainContext("#" + "x".repeat(10_000));
    expect(long.length).toBeLessThan(7_000);
  });
});
