import { EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

// Notion/Obsidian-style editing commands for the markdown surface. Every command
// edits plain markdown (wrapping the selection in marks, toggling a heading or
// list prefix, inserting a link) so the document stays the source of truth —
// there's no hidden rich-text state. The Live Preview layer in `livePreview.ts`
// renders the result inline. These are shared by two callers: the keyboard
// shortcuts at the bottom of this file, and the floating selection toolbar
// (`SelectionMenu.tsx`), which calls the exported commands + state helpers.

type Command = (view: EditorView) => boolean;

/** Block type of a single line — the vocabulary of the "Turn into" menu. */
export type Block = "text" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "todo" | "quote";

/** Wrap — or, if already wrapped, unwrap — each selection range in `marker`. */
function toggleWrap(marker: string): Command {
  const mLen = marker.length;
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const doc = state.doc;
      const inner = doc.sliceString(range.from, range.to);
      // Marks live *inside* the selection (e.g. you selected "**bold**") → strip.
      if (inner.length >= 2 * mLen && inner.startsWith(marker) && inner.endsWith(marker)) {
        const stripped = inner.slice(mLen, inner.length - mLen);
        return {
          changes: { from: range.from, to: range.to, insert: stripped },
          range: EditorSelection.range(range.from, range.from + stripped.length),
        };
      }
      // Marks sit just *outside* the selection (e.g. **|bold|**) → strip them.
      const before = doc.sliceString(Math.max(0, range.from - mLen), range.from);
      const after = doc.sliceString(range.to, range.to + mLen);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - mLen, to: range.from, insert: "" },
            { from: range.to, to: range.to + mLen, insert: "" },
          ],
          range: EditorSelection.range(range.from - mLen, range.to - mLen),
        };
      }
      // Otherwise wrap. With an empty selection the caret lands between the marks
      // so you can start typing styled text immediately.
      const insert = marker + inner + marker;
      const anchor = range.from + mLen;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(anchor, anchor + inner.length),
      };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: "input" });
    view.focus();
    return true;
  };
}

/** Inline-mark commands, exposed so the toolbar and the keymap share one impl. */
export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("*");
export const toggleCode = toggleWrap("`");
export const toggleStrike = toggleWrap("~~");

/** Turn the selection into a `[text](url)` link, selecting "url" to fill in. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const spec = state.changeByRange((range) => {
    const text = state.doc.sliceString(range.from, range.to);
    if (text) {
      const insert = `[${text}](url)`;
      const urlFrom = range.from + 1 + text.length + 2; // past "[text]("
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlFrom, urlFrom + 3),
      };
    }
    const insert = "[](url)";
    const caret = range.from + 1; // inside the empty []
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(caret, caret),
    };
  });
  view.dispatch(spec, { scrollIntoView: true, userEvent: "input" });
  view.focus();
  return true;
}

/** Set the heading level of each line. `level` 0 (or re-applying) → paragraph. */
export function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const m = /^(#{1,6})[ \t]+/.exec(line.text);
      const curLevel = m ? m[1]!.length : 0;
      const oldLen = m ? m[0].length : 0;
      const prefix = level === 0 || curLevel === level ? "" : "#".repeat(level) + " ";
      const delta = prefix.length - oldLen;
      // Clamp positions that were inside the old prefix to just after the new one.
      const map = (p: number): number =>
        p < line.from + oldLen ? line.from + prefix.length : p + delta;
      return {
        changes: { from: line.from, to: line.from + oldLen, insert: prefix },
        range: EditorSelection.range(map(range.anchor), map(range.head)),
      };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: "input" });
    view.focus();
    return true;
  };
}

// ---- Block ("Turn into") conversions --------------------------------------

// Matches an optional leading indent plus one known block prefix (heading,
// blockquote, task, bullet, or ordered marker) at the start of a line. Group 1
// is the indent, which we preserve; the rest is the prefix we replace.
const BLOCK_PREFIX_RE =
  /^([ \t]*)(?:#{1,6}[ \t]+|>[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+\.[ \t]+)?/;

/** The block type of a line, from its leading markdown prefix. */
export function detectBlock(text: string): Block {
  const h = /^[ \t]*(#{1,6})[ \t]+/.exec(text);
  if (h) {
    const l = h[1]!.length;
    return l === 1 ? "h1" : l === 2 ? "h2" : l === 3 ? "h3" : "text";
  }
  if (/^[ \t]*>[ \t]+/.test(text)) return "quote";
  if (/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/.test(text)) return "todo";
  if (/^[ \t]*[-*+][ \t]+/.test(text)) return "bullet";
  if (/^[ \t]*\d+\.[ \t]+/.test(text)) return "ordered";
  return "text";
}

/** The markdown prefix that produces `target` (with `n` for ordered numbering). */
function prefixFor(target: Block, n: number): string {
  switch (target) {
    case "h1":
      return "# ";
    case "h2":
      return "## ";
    case "h3":
      return "### ";
    case "bullet":
      return "- ";
    case "ordered":
      return `${n}. `;
    case "todo":
      return "- [ ] ";
    case "quote":
      return "> ";
    case "text":
      return "";
  }
}

/**
 * Convert every line touched by the selection to block type `target`, stripping
 * whatever block prefix each line already has. Re-applying the current type
 * (e.g. "Bulleted list" on lines that are already bullets) toggles back to plain
 * text, matching Notion. Blank lines are left untouched so we don't sprinkle
 * empty list items. Ordered lists are numbered sequentially.
 */
export function convertBlock(target: Block): Command {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from).number;
    const last = state.doc.lineAt(sel.to).number;

    // Toggle off when the whole selection already is `target`.
    let allMatch = target !== "text";
    for (let n = first; n <= last && allMatch; n++) {
      const line = state.doc.line(n);
      if (line.length > 0 && detectBlock(line.text) !== target) allMatch = false;
    }
    const effective: Block = allMatch ? "text" : target;

    const changes: { from: number; to: number; insert: string }[] = [];
    let counter = 1;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      if (line.length === 0) continue; // skip blank lines
      const m = BLOCK_PREFIX_RE.exec(line.text)!;
      const indent = m[1] ?? "";
      const stripLen = m[0].length;
      const insert = indent + prefixFor(effective, counter);
      if (effective === "ordered") counter++;
      changes.push({ from: line.from, to: line.from + stripLen, insert });
    }
    if (changes.length === 0) return false;
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    view.focus();
    return true;
  };
}

/** Convenience: convert the selection back to plain paragraph text. */
export const setParagraph = convertBlock("text");

// ---- Clear formatting ------------------------------------------------------

/**
 * Remove balanced inline emphasis / code / strikethrough markers from a string.
 * Strong/strike (two-char) run before emphasis (one-char) so `**_x_**` fully
 * unwraps. Unbalanced markers are left as-is. Pure + exported for unit tests.
 */
export function stripInlineMarks(s: string): string {
  const pairs: [RegExp, string][] = [
    [/\*\*([\s\S]*?)\*\*/g, "$1"],
    [/__([\s\S]*?)__/g, "$1"],
    [/~~([\s\S]*?)~~/g, "$1"],
    [/`([^`]+)`/g, "$1"],
    [/(?<!\*)\*(?!\*)([\s\S]*?)(?<!\*)\*(?!\*)/g, "$1"],
    [/(?<!_)_(?!_)([\s\S]*?)(?<!_)_(?!_)/g, "$1"],
  ];
  let out = s;
  for (const [re, rep] of pairs) out = out.replace(re, rep);
  return out;
}

/** Strip inline markdown formatting from each non-empty selection range. */
export function clearFormatting(view: EditorView): boolean {
  const { state } = view;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { range };
    const stripped = stripInlineMarks(state.doc.sliceString(range.from, range.to));
    return {
      changes: { from: range.from, to: range.to, insert: stripped },
      range: EditorSelection.range(range.from, range.from + stripped.length),
    };
  });
  view.dispatch(spec, { userEvent: "input" });
  view.focus();
  return true;
}

// ---- Active-state detection (for the toolbar's button highlighting) --------

/** Whether [from, to) is wrapped by `marker`, inside or just outside the range. */
function isWrapped(state: EditorState, from: number, to: number, marker: string): boolean {
  const mLen = marker.length;
  const single = marker === "*" || marker === "_";
  const inner = state.doc.sliceString(from, to);
  if (inner.length >= 2 * mLen && inner.startsWith(marker) && inner.endsWith(marker)) {
    // For single-char emphasis, a doubled marker is bold, not italic — reject it.
    if (!single || (inner[1] !== marker && inner[inner.length - 2] !== marker)) return true;
  }
  const before = state.doc.sliceString(Math.max(0, from - mLen), from);
  const after = state.doc.sliceString(to, to + mLen);
  if (before === marker && after === marker) {
    if (!single) return true;
    const outerBefore = state.doc.sliceString(Math.max(0, from - mLen - 1), from - mLen);
    const outerAfter = state.doc.sliceString(to + mLen, to + mLen + 1);
    if (outerBefore !== marker && outerAfter !== marker) return true;
  }
  return false;
}

export interface ActiveMarks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
}

/** Which inline marks currently wrap the selection — drives button highlights. */
export function activeMarks(state: EditorState, from: number, to: number): ActiveMarks {
  return {
    bold: isWrapped(state, from, to, "**"),
    italic: isWrapped(state, from, to, "*") || isWrapped(state, from, to, "_"),
    strike: isWrapped(state, from, to, "~~"),
    code: isWrapped(state, from, to, "`"),
  };
}

// `Mod` is ⌘ on macOS and Ctrl elsewhere. High precedence so these beat the
// default editor bindings; the slash-menu keymap (navigation keys) is separate.
export const markdownShortcuts: Extension = Prec.high(
  keymap.of([
    { key: "Mod-b", run: toggleBold, preventDefault: true },
    { key: "Mod-i", run: toggleItalic, preventDefault: true },
    { key: "Mod-e", run: toggleCode, preventDefault: true },
    { key: "Mod-Shift-x", run: toggleStrike, preventDefault: true },
    { key: "Mod-k", run: insertLink, preventDefault: true },
    { key: "Mod-Alt-1", run: setHeading(1), preventDefault: true },
    { key: "Mod-Alt-2", run: setHeading(2), preventDefault: true },
    { key: "Mod-Alt-3", run: setHeading(3), preventDefault: true },
    { key: "Mod-Alt-0", run: setHeading(0), preventDefault: true },
  ]),
);
