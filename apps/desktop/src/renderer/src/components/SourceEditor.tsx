import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  activeLineHandle,
  imagePaste,
  livePreview,
  slashMenu,
  type LineHandleInfo,
  type SlashController,
  type SlashRender,
} from "@renderer/vault/livePreview";
import { selectionMenu, type SelectionRender } from "@renderer/vault/selectionMenu";
import { markdownShortcuts } from "@renderer/vault/editorCommands";
import { SlashMenu } from "@renderer/components/SlashMenu";
import { SelectionMenu } from "@renderer/components/SelectionMenu";
import type { AiRewrite } from "@renderer/vault/useAi";
import type { PrivacyMode } from "@kestravault/core";

interface SourceEditorProps {
  /** Identity of the open doc; a change reloads the editor contents. */
  path: string | null;
  doc: string;
  files: { name: string; path: string }[];
  onChange: (next: string) => void;
  onOpenWikiLink: (target: string) => void;
  /** Called when this editor gains focus (so the workspace can track it). */
  onFocus?: () => void;
  /** Expose the CodeMirror view (e.g. for the outline to scroll to a heading). */
  registerView?: (view: EditorView | null) => void;
  /** Bound AI call for the selection toolbar's inline rewrite (null → disabled). */
  aiRewrite: AiRewrite | null;
  /** Provider runs on-device → Private notes are unrestricted for inline AI. */
  aiIsLocal: boolean;
  /** Effective privacy for the open note. */
  notePrivacyMode: PrivacyMode;
  /** Run a vault skill chosen from the "/" menu's Actions group. */
  onRunSkill?: (id: string) => void;
}

// A single CodeMirror 6 surface in Obsidian-style Live Preview: markdown stays
// the source of truth, but renders inline (headings, bold, links, lists) with
// the raw syntax revealed only on the line you're editing. No edit/read toggle.
export function SourceEditor({
  path,
  doc,
  files,
  onChange,
  onOpenWikiLink,
  onFocus,
  registerView,
  aiRewrite,
  aiIsLocal,
  notePrivacyMode,
  onRunSkill,
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Slash "/" command menu, the floating "+" add-block handle, and the
  // selection toolbar. CodeMirror reports their state through the extensions
  // below; React renders the UI.
  const [slash, setSlash] = useState<SlashRender | null>(null);
  const [lineHandle, setLineHandle] = useState<LineHandleInfo | null>(null);
  const [selection, setSelection] = useState<SelectionRender | null>(null);
  const slashCtl = useRef<SlashController | null>(null);
  const registerSlashController = useCallback((c: SlashController | null) => {
    slashCtl.current = c;
  }, []);
  // True while we're programmatically swapping the document (loading a note or
  // following a rename). Edits during a swap aren't the user's, so we must not
  // report them as changes — otherwise switching/renaming notes would re-save
  // the doc (and a transient empty swap could even write a stale file to disk).
  const swapping = useRef(false);

  // Keep latest props reachable from the (once-created) editor extensions.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const filesRef = useRef(files);
  filesRef.current = files;
  const onOpenWikiLinkRef = useRef(onOpenWikiLink);
  onOpenWikiLinkRef.current = onOpenWikiLink;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const registerViewRef = useRef(registerView);
  registerViewRef.current = registerView;

  // Create the EditorView once.
  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !swapping.current) onChangeRef.current(update.state.doc.toString());
      if (update.focusChanged && update.view.hasFocus) onFocusRef.current?.();
    });

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc,
        extensions: [
          history(),
          markdownShortcuts,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // GFM base so task lists ("- [ ]") and ~~strikethrough~~ parse; the
          // built-in markdown keymap (Enter continues a list, Backspace clears
          // the markup) comes along with it.
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          placeholder("Write something, or type '/' for commands…"),
          livePreview({
            getFiles: () => filesRef.current,
            onOpenWikiLink: (t) => onOpenWikiLinkRef.current(t),
          }),
          imagePaste,
          slashMenu({ getController: () => slashCtl.current, onChange: setSlash }),
          selectionMenu({ onChange: setSelection }),
          activeLineHandle(setLineHandle),
          updateListener,
        ],
      }),
    });
    viewRef.current = view;
    registerViewRef.current?.(view);
    return () => {
      registerViewRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once; `doc` swaps are handled by the effect below.
  }, []);

  // When the selected file (or its content) changes, replace the document. This
  // is a programmatic swap, not a user edit, so guard it so the update listener
  // doesn't report it back as a change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === doc) return;
    swapping.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    } finally {
      swapping.current = false;
    }
  }, [doc, path]);

  // The "+" handle drops a "/" at the empty line's start, which opens the menu.
  function openSlashAt(lineFrom: number): void {
    const view = viewRef.current;
    if (!view) return;
    view.focus();
    view.dispatch({
      changes: { from: lineFrom, insert: "/" },
      selection: { anchor: lineFrom + 1 },
      userEvent: "input.type",
    });
  }

  return (
    <>
      <div className="editor-host" ref={hostRef} />
      {lineHandle && !slash ? (
        <button
          type="button"
          className="slash-add-handle"
          title="Insert block"
          aria-label="Insert block"
          style={{ top: lineHandle.top - 1, left: lineHandle.left - 26 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openSlashAt(lineHandle.lineFrom)}
        >
          +
        </button>
      ) : null}
      <SlashMenu
        render={slash}
        view={viewRef.current}
        registerController={registerSlashController}
        onRunSkill={onRunSkill}
      />
      <SelectionMenu
        render={selection}
        view={viewRef.current}
        aiRewrite={aiRewrite}
        aiIsLocal={aiIsLocal}
        notePrivacyMode={notePrivacyMode}
      />
    </>
  );
}
