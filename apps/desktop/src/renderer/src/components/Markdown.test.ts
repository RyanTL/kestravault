import { describe, expect, it } from "vitest";
import { safeHref } from "./Markdown";

// safeHref is the link sanitizer for AI/markdown output. The model and note
// content are untrusted, so anything that isn't an explicit-safe scheme or an
// in-app relative/anchor link must be rejected (returned as undefined) — the
// caller then renders plain text instead of a clickable link.
describe("safeHref", () => {
  it("allows http, https, and mailto URLs", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com/path?q=1#frag")).toBe("http://example.com/path?q=1#frag");
    expect(safeHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
  });

  it("is case-insensitive about the scheme", () => {
    expect(safeHref("HTTPS://Example.com")).toBe("HTTPS://Example.com");
    expect(safeHref("MailTo:hi@example.com")).toBe("MailTo:hi@example.com");
  });

  it("allows in-app anchors and relative paths", () => {
    expect(safeHref("#heading")).toBe("#heading");
    expect(safeHref("/notes/foo")).toBe("/notes/foo");
    expect(safeHref("./sibling.md")).toBe("./sibling.md");
    expect(safeHref("../parent.md")).toBe("../parent.md");
  });

  it("allows schemeless hosts and bare wiki-style words", () => {
    expect(safeHref("example.com/page")).toBe("example.com/page");
    expect(safeHref("Some Note")).toBe("Some Note");
  });

  it("blocks dangerous schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeHref("file:///etc/passwd")).toBeUndefined();
  });

  it("trims surrounding whitespace before deciding, and returns the trimmed URL", () => {
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
    expect(safeHref("\tjavascript:alert(1)\n")).toBeUndefined();
  });
});
