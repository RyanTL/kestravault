import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Pane } from "@renderer/vault/useWorkspace";
import type { SaveState } from "@renderer/vault/useVault";
import { noteName } from "@renderer/vault/paths";

interface TabBarProps {
  pane: Pane;
  saveStateOf: (path: string) => SaveState | undefined;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onMoveTab: (fromPaneId: string, path: string, toPaneId: string, toIndex: number | null) => void;
}

// Live mechanics of an in-progress drag (kept in a ref so per-pointer moves
// don't thrash React state until something visible actually changes).
interface DragSession {
  path: string;
  pointerId: number;
  startX: number;
  startY: number;
  el: HTMLElement;
  dragging: boolean;
}

interface DropTarget {
  paneId: string;
  index: number;
}

interface Ghost {
  x: number;
  y: number;
  label: string;
}

interface Indicator {
  x: number;
  top: number;
  height: number;
}

const DRAG_THRESHOLD = 5;

export function TabBar({ pane, saveStateOf, onSelectTab, onCloseTab, onMoveTab }: TabBarProps) {
  const sessionRef = useRef<DragSession | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);

  // Find the tab strip + insertion index under the cursor. Works across panes
  // by reading `data-pane-id` off whichever `.tabs` strip we're hovering, and
  // excludes the tab being dragged so the index matches the post-move array.
  function computeDrop(
    clientX: number,
    clientY: number,
    draggedPath: string,
  ): { drop: DropTarget; indicator: Indicator } | null {
    const hit = document.elementFromPoint(clientX, clientY);
    const strip = hit?.closest<HTMLElement>(".tabs");
    if (!strip || !strip.dataset.paneId) return null;
    const paneId = strip.dataset.paneId;
    const others = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).filter(
      (el) => el.dataset.path !== draggedPath,
    );

    let index = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) index++;
    }

    let line: Indicator;
    if (others.length === 0) {
      const r = strip.getBoundingClientRect();
      line = { x: r.left + 5, top: r.top + 4, height: Math.max(0, r.height - 8) };
    } else if (index >= others.length) {
      const r = others[others.length - 1]!.getBoundingClientRect();
      line = { x: r.right + 1, top: r.top, height: r.height };
    } else {
      const r = others[index]!.getBoundingClientRect();
      line = { x: r.left - 1, top: r.top, height: r.height };
    }
    return { drop: { paneId, index }, indicator: line };
  }

  function endDrag(): void {
    sessionRef.current = null;
    dropRef.current = null;
    setDraggingPath(null);
    setGhost(null);
    setIndicator(null);
    document.body.classList.remove("is-tab-dragging");
  }

  function onPointerDown(e: React.PointerEvent, path: string): void {
    if (e.button !== 0) return;
    onSelectTab(path); // grabbing a tab focuses it, Obsidian-style
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    sessionRef.current = {
      path,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      el,
      dragging: false,
    };
  }

  function onPointerMove(e: React.PointerEvent): void {
    const s = sessionRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (!s.dragging) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD) return;
      s.dragging = true;
      setDraggingPath(s.path);
      document.body.classList.add("is-tab-dragging");
    }
    const found = computeDrop(e.clientX, e.clientY, s.path);
    dropRef.current = found?.drop ?? null;
    setIndicator(found?.indicator ?? null);
    setGhost({ x: e.clientX, y: e.clientY, label: noteName(s.path) });
  }

  function onPointerUp(e: React.PointerEvent): void {
    const s = sessionRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    try {
      s.el.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone
    }
    if (s.dragging) {
      const drop = dropRef.current;
      if (drop) onMoveTab(pane.id, s.path, drop.paneId, drop.index);
    }
    endDrag();
  }

  return (
    <div className="tabbar">
      <div className="tabs" data-pane-id={pane.id}>
        {pane.tabs.map((path) => {
          const dirty = saveStateOf(path) === "dirty" || saveStateOf(path) === "saving";
          return (
            <div
              key={path}
              data-path={path}
              className={`tab${path === pane.active ? " is-active" : ""}${
                path === draggingPath ? " is-dragging" : ""
              }`}
              onPointerDown={(e) => onPointerDown(e, path)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => endDrag()}
              title={path}
            >
              <span className="tab-title">{noteName(path)}</span>
              <button
                className={`tab-close${dirty ? " is-dirty" : ""}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(path);
                }}
                title="Close tab"
              >
                <span className="tab-dot" />
                <span className="tab-x">×</span>
              </button>
            </div>
          );
        })}
      </div>

      {ghost
        ? createPortal(
            <div className="tab-ghost" style={{ left: ghost.x, top: ghost.y }}>
              {ghost.label}
            </div>,
            document.body,
          )
        : null}
      {indicator
        ? createPortal(
            <div
              className="tab-drop-line"
              style={{ left: indicator.x, top: indicator.top, height: indicator.height }}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
