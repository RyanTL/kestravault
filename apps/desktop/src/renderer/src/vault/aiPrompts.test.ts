import { describe, it, expect } from "vitest";
import {
  notesContext,
  pageContext,
  PRIVATE_BODY_PLACEHOLDER,
  inlineRewriteSystem,
  inlineRewritePrompt,
  INLINE_AI_ACTIONS,
  isTemporalQuery,
  timeContext,
  balancedExcerpt,
  limitChatHistory,
} from "@renderer/vault/aiPrompts";
import type { NoteMatch } from "@renderer/vault/search";
import type { ActivityContextPayload } from "@renderer/env";

const EMPTY_CTX: ActivityContextPayload = {
  today: [],
  yesterday: [],
  weekTop: [],
  recentDays: [],
  deadlines: [],
};

// A Private note: discoverable by title/description, but its body must never
// appear in a request to a remote provider.
const PRIVATE_NOTE = [
  "---",
  "title: Passwords",
  "description: Logins and account recovery codes",
  "private: true",
  "---",
  "",
  "Gmail: hunter2",
  "Bank PIN: 4321",
].join("\n");

const NORMAL_NOTE = ["---", "title: Groceries", "---", "", "Milk, eggs, and bread"].join("\n");

describe("pageContext", () => {
  it("never includes a Private note's body for a remote provider", () => {
    const out = pageContext("Passwords", PRIVATE_NOTE);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("4321");
    // …but still names/describes the note so the AI can talk about it.
    expect(out).toContain("Passwords");
    expect(out).toContain("Logins and account recovery codes");
    expect(out.toLowerCase()).toContain("private");
  });

  it("includes the full body when the provider is local", () => {
    const out = pageContext("Passwords", PRIVATE_NOTE, { aiIsLocal: true });
    expect(out).toContain("hunter2");
  });

  it("hides the body when path privacy marks a note cloud-AI-private", () => {
    const out = pageContext("Passwords", "Gmail: hunter2", {
      privacyMode: "cloud-ai-private",
    });
    expect(out).toContain("Passwords");
    expect(out).not.toContain("hunter2");
  });

  it("omits local-only body from remote page context", () => {
    const out = pageContext("Passwords", "Gmail: hunter2", { privacyMode: "local-only" });
    expect(out.toLowerCase()).toContain("local-only");
    expect(out).not.toContain("hunter2");
  });

  it("includes the body for a normal note", () => {
    const out = pageContext("Groceries", NORMAL_NOTE);
    expect(out).toContain("Milk, eggs, and bread");
  });
});

describe("chat prompt budgets", () => {
  it("keeps both ends of an oversized active note", () => {
    const excerpt = balancedExcerpt(`START${"x".repeat(20_000)}END`, 1_000);
    expect(excerpt.length).toBe(1_000);
    expect(excerpt).toContain("START");
    expect(excerpt).toContain("END");
    expect(excerpt).toContain("middle omitted");
  });

  it("keeps the current prompt and newest complete conversation pairs", () => {
    const messages = [
      { role: "user" as const, content: "u1".repeat(20) },
      { role: "assistant" as const, content: "a1".repeat(20) },
      { role: "user" as const, content: "u2".repeat(10) },
      { role: "assistant" as const, content: "a2".repeat(10) },
      { role: "user" as const, content: "current" },
    ];
    expect(limitChatHistory(messages, 50)).toEqual(messages.slice(2));
  });

  it("never truncates the current prompt even when it exceeds the budget", () => {
    const current = { role: "user" as const, content: "x".repeat(100) };
    expect(limitChatHistory([current], 10)).toEqual([current]);
  });
});

describe("notesContext", () => {
  it("keeps a Private note findable by title/description but hides its body", () => {
    // Even if a body snippet leaks into the match, notesContext must drop it.
    const match: NoteMatch = {
      path: "Passwords.md",
      name: "Passwords",
      snippet: "Gmail: hunter2",
      score: 10,
      private: true,
      description: "Logins and account recovery codes",
    };
    const out = notesContext([match]);
    expect(out).toContain("Passwords");
    expect(out).toContain("Logins and account recovery codes");
    expect(out).toContain(PRIVATE_BODY_PLACEHOLDER);
    expect(out).not.toContain("hunter2");
  });

  it("shows the snippet for a normal note", () => {
    const match: NoteMatch = {
      path: "Groceries.md",
      name: "Groceries",
      snippet: "Milk, eggs, and bread",
      score: 3,
    };
    expect(notesContext([match])).toContain("Milk, eggs, and bread");
  });
});

describe("isTemporalQuery", () => {
  it("fires on time / schedule / deadline questions", () => {
    for (const q of [
      "what did I work on yesterday?",
      "what have I edited this week",
      "how much time do I have left for the redesign?",
      "when is the tax deadline",
      "what was I doing 3 weeks ago",
    ]) {
      expect(isTemporalQuery(q)).toBe(true);
    }
  });

  it("stays quiet for ordinary questions", () => {
    for (const q of [
      "summarize this note",
      "what is the capital of France",
      "rewrite this paragraph to be clearer",
    ]) {
      expect(isTemporalQuery(q)).toBe(false);
    }
  });
});

describe("timeContext", () => {
  const now = new Date(2026, 6, 1, 14, 30); // Wed Jul 1 2026, 2:30pm (local)

  it("always states the current date, even with no activity", () => {
    const out = timeContext(EMPTY_CTX, now);
    expect(out).toContain("2026");
    expect(out.toLowerCase()).toContain("current date");
  });

  it("summarizes recent activity and deadlines with time remaining", () => {
    const out = timeContext(
      {
        ...EMPTY_CTX,
        today: [{ title: "Q3 Planning", verb: "edited", path: "Q3 Planning.md" }],
        deadlines: [{ title: "Website Redesign", path: "web.md", due: "2026-07-10", daysLeft: 9 }],
      },
      now,
    );
    expect(out).toContain("Q3 Planning");
    expect(out).toContain("Website Redesign");
    expect(out).toContain("9 days left");
  });

  it("never emits an empty deadlines line when there are none", () => {
    expect(timeContext(EMPTY_CTX, now)).not.toContain("deadlines");
  });
});

describe("inline rewrite prompts", () => {
  it("system prompt insists on returning only the transformed text", () => {
    const s = inlineRewriteSystem().toLowerCase();
    expect(s).toContain("only");
    expect(s).toContain("markdown");
  });

  it("user prompt carries both the instruction and the selection", () => {
    const out = inlineRewritePrompt("Make it shorter.", "The quick brown fox jumped.");
    expect(out).toContain("Make it shorter.");
    expect(out).toContain("The quick brown fox jumped.");
    // The selection is fenced so the model can tell instruction from content.
    expect(out).toContain('"""');
  });

  it("every action can produce an instruction (direct, variant, or custom)", () => {
    for (const a of INLINE_AI_ACTIONS) {
      const runnable = !!a.instruction || (a.variants?.length ?? 0) > 0 || a.custom === true;
      expect(runnable).toBe(true);
    }
  });
});
