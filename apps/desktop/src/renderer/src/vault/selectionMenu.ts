import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { activeMarks, detectBlock, type ActiveMarks, type Block } from "@renderer/vault/editorCommands";

// The CodeMirror half of the floating selection toolbar. Deliberately "dumb",
// mirroring the slash-menu split in `livePreview.ts`: it only watches the
// selection, reports the range + an anchor rect + the active marks/block type to
// React, and exposes a highlight effect. All of the toolbar's UI, the command
// catalog, and the inline-AI flow live in `SelectionMenu.tsx`.

/** Viewport-space box of the current selection, so React can anchor the popup. */
export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/** Emitted to React whenever a non-empty selection settles (or null otherwise). */
export interface SelectionRender {
  from: number;
  to: number;
  rect: SelectionRect;
  marks: ActiveMarks;
  block: Block;
}

export interface SelectionMenuOptions {
  onChange: (state: SelectionRender | null) => void;
}

// ---- AI-target highlight ---------------------------------------------------
// While the inline-AI card is open the editor loses focus (focus moves into the
// card), so the native selection highlight vanishes. This decoration keeps the
// targeted passage visibly marked until the user accepts or discards.

const setAiTarget = StateEffect.define<{ from: number; to: number } | null>();

const aiTargetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setAiTarget)) {
        value =
          e.value && e.value.from < e.value.to
            ? Decoration.set(
                Decoration.mark({ class: "cm-ai-target" }).range(e.value.from, e.value.to),
              )
            : Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Highlight [from, to) as the inline-AI target, or clear it when `range` is null. */
export function setAiTargetRange(
  view: EditorView,
  range: { from: number; to: number } | null,
): void {
  view.dispatch({ effects: setAiTarget.of(range) });
}

const targetTheme = EditorView.theme({
  ".cm-ai-target": {
    backgroundColor: "var(--bg-selected)",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px var(--accent-dim, var(--border))",
  },
});

// ---- Selection reporting ---------------------------------------------------

/** Best available viewport box for the selection (native rect, else caret coords). */
function selectionRect(view: EditorView, from: number, to: number): SelectionRect | null {
  const dom = window.getSelection();
  if (dom && dom.rangeCount > 0) {
    const r = dom.getRangeAt(0).getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) {
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
    }
  }
  const a = view.coordsAtPos(from);
  const b = view.coordsAtPos(to);
  if (!a || !b) return null;
  const left = Math.min(a.left, b.left);
  return {
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
    left,
    width: Math.max(a.left, b.left) - left,
  };
}

function computeRender(view: EditorView): SelectionRender | null {
  if (!view.hasFocus) return null;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const rect = selectionRect(view, sel.from, sel.to);
  if (!rect) return null;
  return {
    from: sel.from,
    to: sel.to,
    rect,
    marks: activeMarks(view.state, sel.from, sel.to),
    block: detectBlock(view.state.doc.lineAt(sel.head).text),
  };
}

function marksEqual(a: ActiveMarks, b: ActiveMarks): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;
}

function sameRender(a: SelectionRender | null, b: SelectionRender | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.block === b.block &&
    marksEqual(a.marks, b.marks) &&
    Math.abs(a.rect.top - b.rect.top) < 0.5 &&
    Math.abs(a.rect.left - b.rect.left) < 0.5 &&
    Math.abs(a.rect.width - b.rect.width) < 0.5
  );
}

export function selectionMenu(opts: SelectionMenuOptions): Extension {
  // Notion only shows the bar once a drag ends, so suppress emits mid-drag and
  // re-fire on mouseup. Keyboard selection (shift+arrows) has no drag and flows
  // straight through the update listener below.
  let dragging = false;
  let last: SelectionRender | null = null;

  const emit = (view: EditorView): void => {
    const next = dragging ? null : computeRender(view);
    if (!sameRender(last, next)) {
      last = next;
      opts.onChange(next);
    }
  };

  const listener = EditorView.updateListener.of((u: ViewUpdate) => {
    if (
      u.docChanged ||
      u.selectionSet ||
      u.focusChanged ||
      u.geometryChanged ||
      u.viewportChanged
    ) {
      emit(u.view);
    }
  });

  const drag = EditorView.domEventHandlers({
    mousedown(_e, view) {
      dragging = true;
      emit(view); // hide immediately while selecting
      return false;
    },
    mouseup(_e, view) {
      dragging = false;
      // Let the selection finalize, then re-anchor to the settled box.
      requestAnimationFrame(() => emit(view));
      return false;
    },
  });

  return [aiTargetField, targetTheme, listener, drag];
}
