import { describe, it, expect } from "vitest";
import { stripInlineMarks, detectBlock } from "@renderer/vault/editorCommands";

// Pure helpers behind the selection toolbar's "Clear formatting" button and the
// "Turn into" label. The CodeMirror commands themselves need a DOM (verified by
// running the app); these string transforms are covered here.

describe("stripInlineMarks", () => {
  it("removes bold, italic, code, and strikethrough wrappers", () => {
    expect(stripInlineMarks("**bold**")).toBe("bold");
    expect(stripInlineMarks("*italic*")).toBe("italic");
    expect(stripInlineMarks("_italic_")).toBe("italic");
    expect(stripInlineMarks("`code`")).toBe("code");
    expect(stripInlineMarks("~~gone~~")).toBe("gone");
  });

  it("unwraps nested emphasis fully", () => {
    expect(stripInlineMarks("**_both_**")).toBe("both");
  });

  it("strips marks mid-sentence while leaving plain text intact", () => {
    expect(stripInlineMarks("a **b** and *c* here")).toBe("a b and c here");
  });

  it("leaves unbalanced markers untouched", () => {
    expect(stripInlineMarks("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("detectBlock", () => {
  it("classifies each markdown block prefix", () => {
    expect(detectBlock("# Title")).toBe("h1");
    expect(detectBlock("## Sub")).toBe("h2");
    expect(detectBlock("### Small")).toBe("h3");
    expect(detectBlock("- item")).toBe("bullet");
    expect(detectBlock("1. item")).toBe("ordered");
    expect(detectBlock("- [ ] task")).toBe("todo");
    expect(detectBlock("- [x] done")).toBe("todo");
    expect(detectBlock("> quote")).toBe("quote");
    expect(detectBlock("plain text")).toBe("text");
  });
});
