import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentChangedFile,
  AgentOpKind,
  AiChatMessage,
  AiErrorKind,
  AiProviderConfig,
  AiStatus,
  EffortLevel,
} from "@renderer/env";

export type ConnState = "unknown" | "checking" | "connected" | "disconnected";

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (full: string) => void;
  onError: (kind: AiErrorKind, message: string) => void;
}

/** Handlers for a vault agent operation (a skill) — a tool-using run. */
export interface AgentHandlers extends Omit<StreamHandlers, "onDone"> {
  /** A tool call was allowed — e.g. "write projects/x.md". */
  onTool: (action: "read" | "search" | "write" | "move", path?: string) => void;
  onDone: (full: string, changed: AgentChangedFile[]) => void;
}

/**
 * A single-shot AI call bound to the current model: used by the selection
 * toolbar's inline rewrite. The app builds this from `stream` so the component
 * doesn't need to know about message shaping or the active model.
 */
export type AiRewrite = (
  system: string,
  userText: string,
  handlers: StreamHandlers,
) => { cancel: () => void };

let nextId = 0;
const newRequestId = (): string => `ai-${Date.now()}-${nextId++}`;

/**
 * Renderer-side AI controller. Owns the connection status and fans the single
 * `ai:event` stream out to per-request handlers, so several callers (chat panel,
 * inline actions) can share one IPC subscription.
 *
 * `getProvider` returns the user's current AI provider config (from Settings);
 * it's read fresh on every send/probe so changing providers takes effect at once
 * without re-subscribing.
 */
export function useAi(getProvider?: () => AiProviderConfig | undefined) {
  const [conn, setConn] = useState<ConnState>("unknown");
  const [status, setStatus] = useState<AiStatus | null>(null);
  const handlers = useRef(new Map<string, StreamHandlers>());
  const agentHandlers = useRef(new Map<string, AgentHandlers>());

  const providerRef = useRef(getProvider);
  providerRef.current = getProvider;
  const provider = (): AiProviderConfig | undefined => providerRef.current?.();

  useEffect(() => {
    return window.api.ai.onEvent((e) => {
      const h = handlers.current.get(e.requestId);
      if (!h) return;
      if (e.type === "delta") h.onDelta(e.text);
      else if (e.type === "done") {
        handlers.current.delete(e.requestId);
        h.onDone(e.text);
      } else {
        handlers.current.delete(e.requestId);
        if (e.kind === "auth") setConn("disconnected");
        h.onError(e.kind, e.message);
      }
    });
  }, []);

  useEffect(() => {
    return window.api.ai.onAgentEvent((e) => {
      const h = agentHandlers.current.get(e.requestId);
      if (!h) return;
      if (e.type === "delta") h.onDelta(e.text);
      else if (e.type === "tool") h.onTool(e.action, e.path);
      else if (e.type === "done") {
        agentHandlers.current.delete(e.requestId);
        h.onDone(e.text, e.changed);
      } else {
        agentHandlers.current.delete(e.requestId);
        if (e.kind === "auth") setConn("disconnected");
        h.onError(e.kind, e.message);
      }
    });
  }, []);

  const checkStatus = useCallback(async (force = false): Promise<AiStatus> => {
    setConn("checking");
    const s = await window.api.ai.status(provider(), force);
    setStatus(s);
    setConn(s.connected ? "connected" : "disconnected");
    return s;
  }, []);

  const recheck = useCallback(async (): Promise<AiStatus> => {
    await window.api.ai.resetStatus();
    return checkStatus(true);
  }, [checkStatus]);

  /**
   * Drop any cached status and reset to "unknown" without spending a probe.
   * Call this when the provider config changes so the next `checkStatus` (e.g.
   * when the chat panel next opens) re-probes against the new provider.
   */
  const invalidate = useCallback((): void => {
    void window.api.ai.resetStatus();
    setStatus(null);
    setConn("unknown");
  }, []);

  /** Start a streamed request. Returns the id and a cancel fn. */
  const stream = useCallback(
    (
      system: string,
      messages: AiChatMessage[],
      model: string | undefined,
      h: StreamHandlers,
      effort?: EffortLevel,
    ): { id: string; cancel: () => void } => {
      const id = newRequestId();
      handlers.current.set(id, h);
      void window.api.ai.send({
        requestId: id,
        system,
        messages,
        model,
        effort,
        provider: provider(),
      });
      return {
        id,
        cancel: () => void window.api.ai.cancel(id),
      };
    },
    [],
  );

  /** Run a vault agent operation (a skill). Returns the id and a cancel fn. */
  const agentRun = useCallback(
    (
      op: AgentOpKind,
      opts: { targetPath?: string; model?: string; prompt?: string },
      h: AgentHandlers,
    ): { id: string; cancel: () => void } => {
      const id = newRequestId();
      agentHandlers.current.set(id, h);
      void window.api.ai.agent({
        requestId: id,
        op,
        targetPath: opts.targetPath,
        prompt: opts.prompt,
        model: opts.model,
        provider: provider(),
      });
      return { id, cancel: () => void window.api.ai.cancel(id) };
    },
    [],
  );

  return { conn, status, checkStatus, recheck, invalidate, stream, agentRun };
}

export type AiController = ReturnType<typeof useAi>;
