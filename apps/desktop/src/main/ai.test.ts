import { describe, expect, it, vi } from "vitest";

// ai.ts reaches Electron transitively through vault.js / secrets.js and pulls in
// the heavy Claude Agent SDK. None of that is needed to exercise the pure env
// scrubbing, so stub them out — the test then loads fast and in plain Node.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("./vault.js", () => ({ vaultRoot: () => "/tmp/vault" }));
vi.mock("./secrets.js", () => ({
  getSecret: () => undefined,
  keyFingerprint: () => "",
}));

import { cleanEnv, SUBSCRIPTION_ENV_OVERRIDES } from "./ai.js";

describe("cleanEnv — subscription auth env scrubbing", () => {
  it("strips every endpoint/auth override so the subscription reaches real Claude", () => {
    const dirty: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/ryan",
      ANTHROPIC_API_KEY: "sk-ant-leftover",
      ANTHROPIC_AUTH_TOKEN: "bearer-leak",
      ANTHROPIC_BASE_URL: "https://staging.example/api",
      ANTHROPIC_CUSTOM_HEADERS: "x-foo: bar",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      USE_STAGING_OAUTH: "true",
      USE_LOCAL_OAUTH: "true",
    };

    const cleaned = cleanEnv(dirty);

    // Every override is gone…
    for (const key of SUBSCRIPTION_ENV_OVERRIDES) {
      expect(cleaned[key]).toBeUndefined();
      expect(key in cleaned).toBe(false);
    }
    // …while the ordinary environment the child still needs is preserved.
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.HOME).toBe("/Users/ryan");
  });

  it("deletes keys rather than setting them to the string 'undefined'", () => {
    // Some Node versions stringify an assigned `undefined`, which the child would
    // then treat as a real value; deletion avoids that footgun entirely.
    const cleaned = cleanEnv({ ANTHROPIC_BASE_URL: "https://proxy.local" });
    expect(Object.prototype.hasOwnProperty.call(cleaned, "ANTHROPIC_BASE_URL")).toBe(false);
  });

  it("does not mutate the source env", () => {
    const src: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/bin" };
    cleanEnv(src);
    expect(src.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });

  it("is a no-op for an already-clean environment", () => {
    const clean: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/x", LANG: "en_US.UTF-8" };
    expect(cleanEnv(clean)).toEqual(clean);
  });
});
