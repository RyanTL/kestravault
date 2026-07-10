import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  type EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { resolveWikiLink } from "@renderer/vault/paths";

// Obsidian-style "Live Preview": one editing surface that renders markdown
// inline (headings sized, bold/italic styled, wikilinks as links) while showing
// the raw markdown only on the line the cursor is on. Built with CodeMirror
// decorations off the markdown syntax tree, plus a regex pass for [[wikilinks]]
// (which the markdown grammar doesn't know about).

export interface LivePreviewOptions {
  getFiles: () => { name: string; path: string }[];
  onOpenWikiLink: (target: string) => void;
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Length of the leading YAML frontmatter block, or 0 if there isn't one. */
function frontmatterEnd(text: string): number {
  return FRONTMATTER_RE.exec(text)?.[0].length ?? 0;
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}

// A real, clickable checkbox standing in for a `[ ]` / `[x]` task marker.
// Clicking it flips the marker in the underlying markdown (and so re-renders),
// matching the way Notion and Obsidian let you tick a to-do without editing it.
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Mark task as not done" : "Mark task as done");
    // Don't let the click move the caret into the widget; just toggle the marker.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box));
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// ── Inline images ────────────────────────────────────────────────────────────
// `![alt](assets/pic.png)` renders as the actual image (Obsidian-style) except
// on the cursor's line, where the raw markdown shows for editing. Bytes come
// over IPC as base64 (the CSP allows data: images); the per-path cache clears
// whenever the vault changes externally (sync pull, agent write).

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/** Vault-local image reference? (Remote URLs are blocked by the CSP anyway.) */
function isLocalImage(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) && IMAGE_EXT_RE.test(src);
}

function imageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  return `image/${ext}`;
}

const assetUrlCache = new Map<string, Promise<string | null>>();
let assetCacheWired = false;

function loadAssetUrl(path: string): Promise<string | null> {
  if (!assetCacheWired) {
    assetCacheWired = true;
    try {
      window.api.vault.onChanged(() => assetUrlCache.clear());
    } catch {
      // Non-Electron host (demo harness) — cache just never invalidates.
    }
  }
  let pending = assetUrlCache.get(path);
  if (!pending) {
    pending = window.api.vault
      .readBinary(path)
      .then((b64) => `data:${imageMime(path)};base64,${b64}`)
      .catch(() => null);
    assetUrlCache.set(path, pending);
  }
  return pending;
}

class ImageWidget extends WidgetType {
  constructor(readonly path: string) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.path === this.path;
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-embed";
    const img = document.createElement("img");
    img.alt = this.path;
    img.draggable = false;
    wrap.appendChild(img);
    void loadAssetUrl(this.path).then((url) => {
      if (url) {
        img.src = url;
      } else {
        wrap.classList.add("is-missing");
        wrap.textContent = `Image not found: ${this.path}`;
      }
    });
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Paste/drop an image file into the editor: the bytes are written into the
 * vault's `assets/` folder and a standard `![](assets/…)` embed is inserted at
 * the cursor (Obsidian's behavior). Text pastes are untouched.
 */
export const imagePaste: Extension = EditorView.domEventHandlers({
  paste: (event, view) => {
    if (!handleImageTransfer(event.clipboardData, view)) return false;
    event.preventDefault();
    return true;
  },
  drop: (event, view) => {
    if (!handleImageTransfer(event.dataTransfer, view)) return false;
    event.preventDefault();
    return true;
  },
});

function handleImageTransfer(data: DataTransfer | null, view: EditorView): boolean {
  const files = [...(data?.files ?? [])].filter(
    (f) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name),
  );
  if (files.length === 0) return false;
  for (const file of files) {
    void (async () => {
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      // Chunked conversion: String.fromCharCode(...whole file) blows the stack.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const ext = file.name.match(/\.\w+$/)?.[0] ?? extFromMime(file.type);
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", " ")
        .slice(0, 15);
      const name = /^image\.|^blob$|^$/i.test(file.name)
        ? `Pasted image ${stamp}${ext}`
        : file.name;
      const written = await window.api.vault.writeBinary(`assets/${name}`, btoa(bin));
      const embed = `![](${written.split("/").map(encodeURIComponent).join("/")})`;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: embed },
        selection: { anchor: from + embed.length },
        userEvent: "input.paste",
      });
    })();
  }
  return true;
}

function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/svg+xml") return ".svg";
  const sub = mime.split("/")[1];
  return sub ? `.${sub}` : ".png";
}

/** Flip the `[ ]`↔`[x]` task marker on the line containing `pos`. */
function toggleTaskAt(view: EditorView, pos: number): void {
  const line = view.state.doc.lineAt(pos);
  const m = /^(\s*[-*+][ \t]+\[)([ xX])(\])/.exec(line.text);
  if (!m) return;
  const at = line.from + m[1]!.length;
  const next = m[2] === " " ? "x" : " ";
  view.dispatch({ changes: { from: at, to: at + 1, insert: next }, userEvent: "input" });
}

// Typing the closing `]` of an empty `[]` at the start of a line turns it into a
// proper GFM task: `[ ] ` (and a `- ` bullet if there isn't one). Without this,
// `[]` never becomes a checkbox — the markdown grammar only recognizes `[ ]`/`[x]`
// inside a list item, so a bare or space-less `[]` just stays raw text.
const taskInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "]" || !view.state.selection.main.empty || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  const m = /^(\s*)([-*+] )?\[$/.exec(before);
  if (!m) return false;
  const replacement = `${m[1] ?? ""}${m[2] ?? "- "}[ ] `;
  view.dispatch({
    changes: { from: line.from, to: from, insert: replacement },
    selection: { anchor: line.from + replacement.length },
    userEvent: "input",
  });
  return true;
});

function buildDecorations(
  view: EditorView,
  files: { name: string; path: string }[],
): DecorationSet {
  const { state } = view;
  const sel = state.selection;
  const decos: Range<Decoration>[] = [];

  const selTouches = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number): boolean => {
    const line = state.doc.lineAt(pos);
    return selTouches(line.from, line.to);
  };

  try {
    // The frontmatter block itself is hidden by `frontmatterField` (block
    // decorations must come from a state field, not a plugin). Here we only need
    // its length so the inline pass skips anything inside it.
    const fmEnd = frontmatterEnd(state.doc.toString());

    const tree = syntaxTree(state);
    for (const { from: vf, to: vt } of view.visibleRanges) {
      tree.iterate({
        from: vf,
        to: vt,
        enter: (node) => {
          const { name, from, to } = node;
          // Skip nodes *entirely* inside the hidden frontmatter — but never the
          // root/container nodes that merely start at 0, or we'd stop descending
          // into the whole document and render nothing.
          if (to <= fmEnd) return false;

          if (name.startsWith("ATXHeading")) {
            const level = Number(name.slice("ATXHeading".length)) || 1;
            decos.push(
              Decoration.line({ class: `cm-h${level}` }).range(state.doc.lineAt(from).from),
            );
            return;
          }
          if (name === "HeaderMark") {
            if (!lineTouched(from)) {
              const end = state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
              decos.push(Decoration.replace({}).range(from, end));
            }
            return;
          }
          if (name === "StrongEmphasis" || name === "Emphasis") {
            const markLen = name === "StrongEmphasis" ? 2 : 1;
            decos.push(
              Decoration.mark({
                class: name === "StrongEmphasis" ? "cm-strong" : "cm-em",
              }).range(from, to),
            );
            if (!selTouches(from, to) && to - from > markLen * 2) {
              decos.push(Decoration.replace({}).range(from, from + markLen));
              decos.push(Decoration.replace({}).range(to - markLen, to));
            }
            return;
          }
          if (name === "InlineCode") {
            decos.push(Decoration.mark({ class: "cm-inline-code" }).range(from, to));
            if (!selTouches(from, to)) {
              const open = state.doc.sliceString(from, to).match(/^`+/)?.[0].length ?? 1;
              if (to - from > open * 2) {
                decos.push(Decoration.replace({}).range(from, from + open));
                decos.push(Decoration.replace({}).range(to - open, to));
              }
            }
            return;
          }
          if (name === "ListMark") {
            const markText = state.doc.sliceString(from, to);
            // On a task line ("- [ ] …") hide the bullet markup entirely — the
            // rendered checkbox (from the TaskMarker below) stands in for it.
            if (/^\s*[-*+][ \t]+\[[ xX]\][ \t]/.test(state.doc.lineAt(from).text)) {
              const end = state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
              decos.push(Decoration.replace({}).range(from, end));
              return;
            }
            if (/^[-*+]$/.test(markText) && !lineTouched(from)) {
              decos.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
            }
            return;
          }
          if (name === "Task") {
            // The whole "[ ]/[x] text" run. Dim + strike the line when it's done.
            if (state.doc.sliceString(from + 1, from + 2).toLowerCase() === "x") {
              decos.push(
                Decoration.line({ class: "cm-task-done" }).range(state.doc.lineAt(from).from),
              );
            }
            return; // descend so the TaskMarker + inline markup still render
          }
          if (name === "TaskMarker") {
            const checked = state.doc.sliceString(from + 1, from + 2).toLowerCase() === "x";
            decos.push(
              Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to),
            );
            return;
          }
          if (name === "Strikethrough") {
            decos.push(Decoration.mark({ class: "cm-strike" }).range(from, to));
            if (!selTouches(from, to) && to - from > 4) {
              decos.push(Decoration.replace({}).range(from, from + 2));
              decos.push(Decoration.replace({}).range(to - 2, to));
            }
            return;
          }
          if (name === "Blockquote") {
            const first = state.doc.lineAt(from).number;
            const last = state.doc.lineAt(to).number;
            for (let ln = first; ln <= last; ln++) {
              decos.push(Decoration.line({ class: "cm-quote" }).range(state.doc.line(ln).from));
            }
            return;
          }
          if (name === "QuoteMark") {
            if (!lineTouched(from)) {
              const end = state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
              decos.push(Decoration.replace({}).range(from, end));
            }
            return;
          }
          if (name === "Image") {
            // `![alt](src)` -> the rendered image, unless the cursor is on the
            // line (raw markdown for editing) or the target isn't a vault file.
            const raw = state.doc.sliceString(from, to);
            const m = /^!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(raw);
            const src = decodeURIComponent(m?.[1] ?? "");
            if (m && isLocalImage(src) && !lineTouched(from)) {
              decos.push(
                Decoration.replace({ widget: new ImageWidget(src.replace(/^\.\//, "")) }).range(
                  from,
                  to,
                ),
              );
              return false;
            }
            return;
          }
          if (name === "FencedCode") {
            const first = state.doc.lineAt(from).number;
            const last = state.doc.lineAt(to).number;
            for (let ln = first; ln <= last; ln++) {
              decos.push(
                Decoration.line({ class: "cm-code-line" }).range(state.doc.line(ln).from),
              );
            }
            return false; // don't style inline markup inside code
          }
          return;
        },
      });
    }

    // Wikilinks: collapse to the alias (or target) and make it clickable, except
    // on the line being edited, where the raw [[…]] is shown for editing.
    for (const { from: vf, to: vt } of view.visibleRanges) {
      const text = state.doc.sliceString(vf, vt);
      let m: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(text))) {
        const start = vf + m.index;
        const end = start + m[0].length;
        if (start < fmEnd) continue; // inside hidden frontmatter
        const inner = m[1] ?? "";
        const pipe = inner.indexOf("|");
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
        const aliasStart = start + 2 + (pipe === -1 ? 0 : pipe + 1);
        const aliasEnd = end - 2;
        const cls = `cm-wikilink${resolveWikiLink(target, files) ? "" : " cm-wikilink-unresolved"}`;
        if (selTouches(start, end)) {
          decos.push(Decoration.mark({ class: cls }).range(start, end));
        } else if (aliasEnd > aliasStart) {
          decos.push(Decoration.replace({}).range(start, aliasStart));
          decos.push(
            Decoration.mark({ class: cls, attributes: { "data-wikilink": target } }).range(
              aliasStart,
              aliasEnd,
            ),
          );
          decos.push(Decoration.replace({}).range(aliasEnd, end));
        }
      }
    }

    return Decoration.set(decos, true);
  } catch {
    // Never let a decoration edge-case take down the editor.
    return Decoration.none;
  }
}

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-ui)",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": {
    // Width + size are user settings (Appearance) applied as CSS vars on :root.
    maxWidth: "var(--editor-line-width, 740px)",
    margin: "0 auto",
    padding: "6px 28px 120px",
    fontSize: "var(--editor-font-size, 16px)",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-line": { padding: "2px 0" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--bg-selected) !important",
  },

  ".cm-h1": { fontSize: "1.9em", fontWeight: "700", lineHeight: "1.25", paddingTop: "14px" },
  ".cm-h2": { fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3", paddingTop: "12px" },
  ".cm-h3": { fontSize: "1.25em", fontWeight: "600", paddingTop: "8px" },
  ".cm-h4": { fontSize: "1.1em", fontWeight: "600", paddingTop: "4px" },
  ".cm-h5, .cm-h6": { fontSize: "1em", fontWeight: "600", color: "var(--text-dim)" },

  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-inline-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-code-line": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    background: "var(--bg-raised)",
    padding: "0 14px",
  },
  ".cm-quote": {
    borderLeft: "3px solid var(--accent-dim)",
    paddingLeft: "14px",
    color: "var(--text-dim)",
  },
  ".cm-bullet": { color: "var(--text-faint)", paddingRight: "2px" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--text-dim)" },
  ".cm-task-checkbox": {
    cursor: "pointer",
    width: "15px",
    height: "15px",
    margin: "0 6px 0 0",
    verticalAlign: "-2px",
    accentColor: "var(--accent)",
  },
  ".cm-task-done": { color: "var(--text-faint)", textDecoration: "line-through" },
  ".cm-wikilink": { color: "var(--accent)", cursor: "pointer" },
  ".cm-wikilink:hover": { textDecoration: "underline" },
  ".cm-wikilink-unresolved": { color: "var(--text-faint)" },
});

// Hiding the YAML frontmatter is a *block* replacement, which CodeMirror only
// allows from a state field (not a view plugin). It depends solely on the doc,
// so we recompute it on every document change.
function frontmatterDecorations(text: string): DecorationSet {
  const end = frontmatterEnd(text);
  if (end === 0) return Decoration.none;
  return Decoration.set(Decoration.replace({ block: true }).range(0, end));
}

const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return frontmatterDecorations(state.doc.toString());
  },
  update(value, tr) {
    return tr.docChanged ? frontmatterDecorations(tr.state.doc.toString()) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function livePreview(opts: LivePreviewOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts.getFiles());
      }
      update(u: ViewUpdate): void {
        // Also rebuild when the syntax tree advances: a note loaded from disk
        // parses *after* the initial build, so without this its markdown would
        // stay raw (headings/bold/etc. unrendered) until the first edit.
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildDecorations(u.view, opts.getFiles());
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, _view) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
      const target = el?.getAttribute("data-wikilink");
      if (!target) return false;
      e.preventDefault();
      opts.onOpenWikiLink(target);
      return true;
    },
  });

  return [frontmatterField, plugin, clicks, taskInput, theme];
}

// ════════════════════════════════════════════════════════════════════════
//  Slash "/" command menu
//  Notion-style command palette that opens when you type "/" at the start of
//  a line. The CodeMirror side here is intentionally dumb: it only tracks the
//  trigger (the "/" position + the query typed after it), intercepts the
//  navigation keys while open, and reports state to React. Everything about
//  *which* commands exist and what markdown they insert lives in the React
//  <SlashMenu> component, which drives this through a small controller.
// ════════════════════════════════════════════════════════════════════════

/** The live trigger: where the "/" is and what's been typed after it. */
export interface SlashState {
  /** Document position of the "/" (always a line start). */
  from: number;
  /** Document position of the caret (end of the query). */
  to: number;
  /** Text typed after the "/", e.g. "head" for "/head". Never contains spaces. */
  query: string;
}

/** Viewport coordinates of the trigger, so React can anchor the popup. */
export interface SlashCoords {
  left: number;
  top: number;
  bottom: number;
}

/** What React receives on every change: the state plus where to draw it. */
export interface SlashRender extends SlashState {
  coords: SlashCoords | null;
}

/** Implemented by <SlashMenu>; the keymap calls into it while the menu is open. */
export interface SlashController {
  /** Move the highlight by one row (+1 down, -1 up). */
  move: (dir: 1 | -1) => void;
  /** Run the highlighted command. Returns false if there was nothing to run. */
  confirm: () => boolean;
  /** Dismiss without running anything. */
  close: () => void;
}

export interface SlashMenuOptions {
  /** Latest controller from React (a getter so it's never a stale closure). */
  getController: () => SlashController | null;
  /** Notified whenever the trigger opens, changes, or closes. */
  onChange: (state: SlashRender | null) => void;
}

const closeSlash = StateEffect.define<null>();

/** Derive the slash context purely from the document + caret, or null. */
function slashFromState(state: EditorState): SlashState | null {
  const sel = state.selection.main;
  if (!sel.empty) return null; // a range selection, not a caret
  const head = sel.head;
  const line = state.doc.lineAt(head);
  const before = state.doc.sliceString(line.from, head);
  // "/" must be the first char of the line, followed by a run of non-space
  // characters up to the caret. A space (or newline) ends the command.
  const m = /^\/(\S*)$/.exec(before);
  if (!m) return null;
  return { from: line.from, to: head, query: m[1] ?? "" };
}

const slashField = StateField.define<SlashState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(closeSlash)) return null;

    const next = slashFromState(tr.state);

    if (value) {
      // Already open: stay open only while it's still a valid slash context
      // anchored at the same "/" (mapped through this transaction's edits).
      if (next && next.from === tr.changes.mapPos(value.from, -1)) return next;
      return null;
    }

    // Closed: open only when the user just *typed* a "/" into a valid spot.
    // Plain clicks or selection moves never pop the menu open.
    return next && tr.docChanged ? next : null;
  },
});

/** Current slash state for a view, or null when the menu is closed. */
export function getSlashState(view: EditorView): SlashState | null {
  return view.state.field(slashField, false) ?? null;
}

/** Imperatively dismiss the slash menu (e.g. on blur or after running). */
export function closeSlashMenu(view: EditorView): void {
  if (getSlashState(view)) view.dispatch({ effects: closeSlash.of(null) });
}

export function slashMenu(opts: SlashMenuOptions): Extension {
  // While the menu is open these keys belong to it; otherwise fall through to
  // the normal editor bindings. Highest precedence so we beat the defaults.
  const route = (view: EditorView, fn: (c: SlashController) => boolean): boolean => {
    if (!getSlashState(view)) return false;
    const c = opts.getController();
    if (!c) return false;
    return fn(c);
  };

  const keys = Prec.highest(
    keymap.of([
      {
        key: "ArrowDown",
        run: (v) =>
          route(v, (c) => {
            c.move(1);
            return true;
          }),
      },
      {
        key: "ArrowUp",
        run: (v) =>
          route(v, (c) => {
            c.move(-1);
            return true;
          }),
      },
      { key: "Enter", run: (v) => route(v, (c) => c.confirm()) },
      // Tab always confirms or, with nothing to run, is swallowed so it can't
      // indent the line out from under the open menu.
      {
        key: "Tab",
        run: (v) =>
          route(v, (c) => {
            c.confirm();
            return true;
          }),
      },
      {
        key: "Escape",
        run: (v) =>
          route(v, (c) => {
            c.close();
            return true;
          }),
      },
    ]),
  );

  let last: SlashRender | null = null;
  const notifier = EditorView.updateListener.of((u) => {
    const s = u.state.field(slashField, false) ?? null;
    if (!s) {
      if (last) {
        last = null;
        opts.onChange(null);
      }
      return;
    }
    const c = u.view.coordsAtPos(s.from);
    const render: SlashRender = {
      ...s,
      coords: c ? { left: c.left, top: c.top, bottom: c.bottom } : null,
    };
    // Re-emit on content change and also when the page geometry shifts (scroll,
    // resize) so the popup stays pinned to the "/".
    const moved =
      !last ||
      last.from !== render.from ||
      last.to !== render.to ||
      last.query !== render.query ||
      last.coords?.left !== render.coords?.left ||
      last.coords?.top !== render.coords?.top;
    if (moved || u.geometryChanged || u.viewportChanged) {
      last = render;
      opts.onChange(render);
    }
  });

  // The menu keeps editor focus while you interact with it (it preventDefaults
  // mousedown), so a real blur means the user moved on — dismiss it.
  const blur = EditorView.domEventHandlers({
    blur(_e, view) {
      closeSlashMenu(view);
      return false;
    },
  });

  return [slashField, keys, notifier, blur];
}

// ════════════════════════════════════════════════════════════════════════
//  Active-line "+" handle
//  Reports the screen position of the caret whenever it sits on an empty line,
//  so React can float a Notion-style "+" affordance there. Emits null the rest
//  of the time (non-empty line, a selection, or the editor unfocused).
// ════════════════════════════════════════════════════════════════════════

export interface LineHandleInfo {
  top: number;
  left: number;
  /** Line start, so a click can drop a "/" exactly there. */
  lineFrom: number;
}

export function activeLineHandle(onChange: (info: LineHandleInfo | null) => void): Extension {
  let last: LineHandleInfo | null = null;
  return EditorView.updateListener.of((u) => {
    const view = u.view;
    const sel = u.state.selection.main;
    let info: LineHandleInfo | null = null;
    if (view.hasFocus && sel.empty) {
      const line = u.state.doc.lineAt(sel.head);
      if (line.length === 0) {
        const c = view.coordsAtPos(line.from);
        if (c) info = { top: c.top, left: c.left, lineFrom: line.from };
      }
    }
    const changed =
      !!info !== !!last ||
      (!!info &&
        !!last &&
        (info.top !== last.top || info.left !== last.left || info.lineFrom !== last.lineFrom));
    if (changed) {
      last = info;
      onChange(info);
    }
  });
}
