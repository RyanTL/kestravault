import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Persistent AI chat sessions. Lives at App level (not inside the chat panel)
// so conversations survive closing the panel, switching notes, and app restarts
// — you can always reopen the panel and pick an earlier chat back up.

export interface ChatSource {
  name: string;
  path: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
  sources?: ChatSource[];
  /** Files a vault skill (Ingest / Lint) created or updated during this turn. */
  changed?: { path: string; op: "create" | "update" }[];
  /** Transient "what the agent is doing now" line, shown while streaming. */
  working?: string;
}

export interface Chat {
  id: string;
  title: string;
  turns: ChatTurn[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "kestravault.ai.chats.v1";
const DEFAULT_MODEL = "sonnet";

let seq = 0;
const newChatId = (): string => `chat-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function freshChat(model = DEFAULT_MODEL): Chat {
  const now = Date.now();
  return { id: newChatId(), title: "", turns: [], model, createdAt: now, updatedAt: now };
}

interface Persisted {
  chats: Chat[];
  activeId: string;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      if (Array.isArray(parsed.chats) && parsed.chats.length) {
        // Drop any "streaming" flag left over from a previous session — nothing
        // is in flight on a cold start.
        const chats: Chat[] = parsed.chats.map((c) => ({
          ...c,
          turns: (c.turns ?? []).map((t) => ({ ...t, streaming: false, working: undefined })),
        }));
        const activeId =
          parsed.activeId && chats.some((c) => c.id === parsed.activeId)
            ? parsed.activeId
            : chats[0]!.id;
        return { chats, activeId };
      }
    }
  } catch {
    // Corrupt storage — fall through to a clean slate.
  }
  const first = freshChat();
  return { chats: [first], activeId: first.id };
}

/** First line of the first user message, used as the chat's display title. */
function deriveTitle(turns: ChatTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user");
  if (!firstUser) return "";
  const line = (firstUser.content.trim().split("\n")[0] ?? "").trim();
  return line.length > 48 ? line.slice(0, 47).trimEnd() + "…" : line;
}

export function useChats() {
  const [state, setState] = useState<Persisted>(loadPersisted);
  const { chats, activeId } = state;

  // Mirror state into a ref so async streaming callbacks can read the latest
  // turns/model synchronously (without going stale through closures).
  const ref = useRef<Persisted>(state);
  ref.current = state;

  // Persist, debounced — streaming writes a token at a time, so we coalesce.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ref.current));
      } catch {
        // Ignore quota / serialization failures — chats are best-effort cache.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [state]);

  // `chats` is never empty (every reducer keeps at least one), so the fallback
  // is always defined — assert it so callers get a non-nullable Chat.
  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeId) ?? chats[0]!,
    [chats, activeId],
  );

  const getChat = useCallback((id: string): Chat | undefined => {
    return ref.current.chats.find((c) => c.id === id);
  }, []);

  const select = useCallback((id: string) => {
    setState((s) => (s.activeId === id ? s : { ...s, activeId: id }));
  }, []);

  // Start (and focus) a new chat. Reuses the current chat if it's still empty,
  // so repeatedly clicking "new chat" doesn't pile up blank sessions.
  const startNewChat = useCallback((): string => {
    const cur = ref.current;
    const active = cur.chats.find((c) => c.id === cur.activeId);
    if (active && active.turns.length === 0) return active.id;
    const chat = freshChat(active?.model ?? DEFAULT_MODEL);
    setState((s) => ({ chats: [chat, ...s.chats], activeId: chat.id }));
    return chat.id;
  }, []);

  const deleteChat = useCallback((id: string) => {
    setState((s) => {
      const remaining = s.chats.filter((c) => c.id !== id);
      if (remaining.length === 0) {
        const chat = freshChat();
        return { chats: [chat], activeId: chat.id };
      }
      const nextActive = s.activeId === id ? remaining[0]!.id : s.activeId;
      return { chats: remaining, activeId: nextActive };
    });
  }, []);

  const setModel = useCallback((id: string, model: string) => {
    setState((s) => ({
      ...s,
      chats: s.chats.map((c) => (c.id === id ? { ...c, model } : c)),
    }));
  }, []);

  const updateTurns = useCallback(
    (id: string, updater: (prev: ChatTurn[]) => ChatTurn[]) => {
      setState((s) => {
        let touched = false;
        const next = s.chats.map((c) => {
          if (c.id !== id) return c;
          touched = true;
          const turns = updater(c.turns);
          return { ...c, turns, title: c.title || deriveTitle(turns), updatedAt: Date.now() };
        });
        return touched ? { ...s, chats: next } : s;
      });
    },
    [],
  );

  return {
    chats,
    activeId,
    activeChat,
    getChat,
    select,
    startNewChat,
    deleteChat,
    setModel,
    updateTurns,
  };
}

export type ChatsController = ReturnType<typeof useChats>;
