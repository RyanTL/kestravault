import { describe, expect, it } from "vitest";
import type { Chat } from "@renderer/vault/useChats";
import { initializeChats } from "@renderer/vault/useChats";

function chat(id: string, model: string, content = "Hello"): Chat {
  return {
    id,
    title: content,
    turns: content
      ? [{ id: `${id}-turn`, role: "user", content, streaming: true, working: "Thinking" }]
      : [],
    model,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("initializeChats", () => {
  it("opens a fresh chat on launch while retaining conversation history", () => {
    const older = chat("older", "haiku");
    const previous = chat("previous", "opus");
    const state = initializeChats(
      JSON.stringify({ chats: [older, previous], activeId: previous.id }),
    );

    expect(state.activeId).not.toBe(previous.id);
    expect(state.chats[0]).toMatchObject({
      id: state.activeId,
      model: "opus",
      title: "",
      turns: [],
    });
    expect(state.chats.slice(1).map((item) => item.id)).toEqual(["older", "previous"]);
    expect(state.chats[1]!.turns[0]).toMatchObject({ streaming: false, working: undefined });
  });

  it("does not accumulate unused blank chats across launches", () => {
    const unused = chat("unused", "sonnet", "");
    const previous = chat("previous", "sonnet");
    const state = initializeChats(
      JSON.stringify({ chats: [unused, previous], activeId: unused.id }),
    );

    expect(state.chats).toHaveLength(2);
    expect(state.chats.map((item) => item.id)).not.toContain(unused.id);
    expect(state.chats[1]!.id).toBe(previous.id);
  });
});
