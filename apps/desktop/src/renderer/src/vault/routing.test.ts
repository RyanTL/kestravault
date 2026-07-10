import { describe, expect, it } from "vitest";
import { agentModelFor, gruntModelFor, isRoutable } from "./routing";
import { getPreset } from "./useSettings";

const sub = getPreset("claude-sub");
const api = getPreset("anthropic");
const openai = getPreset("openai");
const ollama = getPreset("ollama");

describe("model routing — tiered models per run", () => {
  it("routes Claude subscription runs across haiku/sonnet/opus", () => {
    expect(agentModelFor(sub, "opus", "light")).toBe("haiku");
    expect(agentModelFor(sub, "haiku", "default")).toBe("sonnet");
    expect(agentModelFor(sub, "sonnet", "deep")).toBe("opus");
  });

  it("routes the Anthropic API to full model ids", () => {
    expect(agentModelFor(api, "claude-opus-4-8", "light")).toBe("claude-haiku-4-5");
    expect(agentModelFor(api, "claude-haiku-4-5", "deep")).toBe("claude-opus-4-8");
  });

  it("falls back to the chat model for providers without a tier ladder", () => {
    expect(agentModelFor(openai, "gpt-4o", "light")).toBe("gpt-4o");
    expect(agentModelFor(ollama, "llama3.1", "deep")).toBe("llama3.1");
  });

  it("gruntModelFor is the light tier", () => {
    expect(gruntModelFor(sub, "opus")).toBe("haiku");
    expect(gruntModelFor(openai, "gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("only Claude providers are routable", () => {
    expect(isRoutable(sub)).toBe(true);
    expect(isRoutable(api)).toBe(true);
    expect(isRoutable(openai)).toBe(false);
    expect(isRoutable(ollama)).toBe(false);
  });
});
