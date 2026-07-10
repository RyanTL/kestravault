import { describe, expect, it } from "vitest";
import {
  remoteAiAccessForPrivacy,
  resolveEffectivePrivacy,
  shouldSyncPrivacyMode,
  type PrivacyRule,
} from "./index.js";

const rule = (
  path: string,
  target: "file" | "folder",
  mode: "public" | "cloud-ai-private" | "local-only",
  updatedAt = "2026-07-09T12:00:00.000Z",
): PrivacyRule => ({ path, target, mode, updatedAt, source: "local" });

describe("resolveEffectivePrivacy", () => {
  it("maps legacy frontmatter private to cloud-ai-private", () => {
    expect(resolveEffectivePrivacy("notes/a.md", "file", [], true)).toMatchObject({
      mode: "cloud-ai-private",
      source: "frontmatter",
      explicit: false,
    });
  });

  it("inherits folder privacy for descendants", () => {
    const rules = [rule("notes/clients", "folder", "cloud-ai-private")];
    expect(resolveEffectivePrivacy("notes/clients/acme.md", "file", rules)).toMatchObject({
      mode: "cloud-ai-private",
      inherited: true,
      rulePath: "notes/clients",
    });
  });

  it("lets an exact child rule override inherited folder privacy", () => {
    const rules = [
      rule("notes/clients", "folder", "cloud-ai-private", "2026-07-09T12:00:00.000Z"),
      rule("notes/clients/acme.md", "file", "public", "2026-07-09T12:01:00.000Z"),
    ];
    expect(resolveEffectivePrivacy("notes/clients/acme.md", "file", rules)).toMatchObject({
      mode: "public",
      explicit: true,
      inherited: false,
    });
  });

  it("uses the closest folder rule when several ancestors match", () => {
    const rules = [
      rule("notes", "folder", "cloud-ai-private"),
      rule("notes/clients", "folder", "public"),
    ];
    expect(resolveEffectivePrivacy("notes/clients/acme.md", "file", rules)).toMatchObject({
      mode: "public",
      rulePath: "notes/clients",
    });
  });

  it("keeps inherited local-only ahead of legacy frontmatter private", () => {
    const rules = [rule("notes/clients", "folder", "local-only")];
    expect(resolveEffectivePrivacy("notes/clients/acme.md", "file", rules, true)).toMatchObject({
      mode: "local-only",
      inherited: true,
    });
  });
});

describe("privacy helpers", () => {
  it("maps privacy modes to remote AI access", () => {
    expect(remoteAiAccessForPrivacy("public")).toBe("full");
    expect(remoteAiAccessForPrivacy("cloud-ai-private")).toBe("metadata");
    expect(remoteAiAccessForPrivacy("local-only")).toBe("none");
    expect(remoteAiAccessForPrivacy("local-only", { aiIsLocal: true })).toBe("full");
  });

  it("only excludes local-only paths from sync", () => {
    expect(shouldSyncPrivacyMode("public")).toBe(true);
    expect(shouldSyncPrivacyMode("cloud-ai-private")).toBe(true);
    expect(shouldSyncPrivacyMode("local-only")).toBe(false);
  });
});
