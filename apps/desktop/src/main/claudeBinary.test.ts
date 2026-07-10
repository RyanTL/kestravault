import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveClaudeExecutable, toUnpackedPath } from "./claudeBinary.js";

describe("toUnpackedPath", () => {
  it("maps an asar-internal path to its extracted twin", () => {
    expect(toUnpackedPath("/Applications/KestraVault.app/Contents/Resources/app.asar/node_modules/x/claude")).toBe(
      "/Applications/KestraVault.app/Contents/Resources/app.asar.unpacked/node_modules/x/claude",
    );
    expect(toUnpackedPath("C:\\Program Files\\KestraVault\\resources\\app.asar\\node_modules\\x\\claude.exe")).toBe(
      "C:\\Program Files\\KestraVault\\resources\\app.asar.unpacked\\node_modules\\x\\claude.exe",
    );
  });

  it("leaves non-asar (dev) paths untouched", () => {
    expect(toUnpackedPath("/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).toBe(
      "/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    );
    // A folder merely *named* app.asar with no separator after it is not an archive path.
    expect(toUnpackedPath("/x/app.asar-backup/claude")).toBe("/x/app.asar-backup/claude");
  });
});

describe("resolveClaudeExecutable", () => {
  it("resolves to a real executable when the platform package is installed", () => {
    const p = resolveClaudeExecutable();
    // Absent on unsupported platforms; when present it must be a real file the
    // SDK can spawn (outside any asar in this test environment).
    if (p !== undefined) {
      expect(p).toMatch(/claude(\.exe)?$/);
      expect(existsSync(p)).toBe(true);
    }
  });
});
