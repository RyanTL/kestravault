import { useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { SourceEditor } from "@renderer/components/SourceEditor";
import { TabBar } from "@renderer/components/TabBar";
import { Breadcrumb } from "@renderer/components/Breadcrumb";
import { InlineTitle } from "@renderer/components/InlineTitle";
import { Properties } from "@renderer/components/Properties";
import type { Pane } from "@renderer/vault/useWorkspace";
import type { SaveState } from "@renderer/vault/useVault";
import type { AiRewrite } from "@renderer/vault/useAi";
import type { PrivacyMode, EffectivePrivacy } from "@kestravault/core";
import { isPrivateNote } from "@renderer/vault/notePrivacy";
import { noteName } from "@renderer/vault/paths";

interface EditorGroupProps {
  pane: Pane;
  isActive: boolean;
  /** Whether the active AI provider is on-device (passed to the Private toggle). */
  aiIsLocal: boolean;
  /** Bound AI call for the selection toolbar's inline rewrite (null → disabled). */
  aiRewrite: AiRewrite | null;
  files: { name: string; path: string; privacy?: EffectivePrivacy }[];
  openDocs: Record<string, { content: string; saveState: SaveState }>;
  onChange: (path: string, next: string) => void;
  onSetPrivacy: (path: string, mode: PrivacyMode) => Promise<void>;
  onClearPrivacy: (path: string) => Promise<void>;
  onRename: (path: string, nextName: string) => void;
  onNavigate: (path: string) => void;
  onOpenWikiLink: (target: string) => void;
  onFocusPane: () => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onRegisterView: (view: EditorView | null) => void;
  onMoveTab: (fromPaneId: string, path: string, toPaneId: string, toIndex: number | null) => void;
  /** Run a vault skill chosen from the editor's "/" menu. */
  onRunSkill?: (id: string) => void;
}

// One editor group: a tab strip, a breadcrumb row, then the active note (its
// editable inline title, properties, and Live Preview editor).
export function EditorGroup({
  pane,
  isActive,
  aiIsLocal,
  aiRewrite,
  files,
  openDocs,
  onChange,
  onSetPrivacy,
  onClearPrivacy,
  onRename,
  onNavigate,
  onOpenWikiLink,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onRegisterView,
  onMoveTab,
  onRunSkill,
}: EditorGroupProps) {
  const active = pane.active;
  const doc = active ? (openDocs[active]?.content ?? "") : "";
  const activePrivacy = active ? files.find((f) => f.path === active)?.privacy : undefined;
  const viewRef = useRef<EditorView | null>(null);

  return (
    <section
      className={`pane pane-center editor-group${isActive ? " is-active-pane" : ""}`}
      onMouseDown={onFocusPane}
    >
      <TabBar
        pane={pane}
        saveStateOf={(p) => openDocs[p]?.saveState}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onMoveTab={onMoveTab}
      />

      {active ? <Breadcrumb path={active} onNavigate={onNavigate} /> : null}

      <div className="editor-body">
        {active ? (
          <>
            <div className="note-head">
              <InlineTitle
                key={active}
                name={noteName(active)}
                onRename={(next) => onRename(active, next)}
                onLeave={() => viewRef.current?.focus()}
              />
              <Properties
                path={active}
                content={doc}
                defaultTitle={noteName(active)}
                aiIsLocal={aiIsLocal}
                privacy={activePrivacy}
                onSetPrivacy={(mode) => onSetPrivacy(active, mode)}
                onClearPrivacy={() => onClearPrivacy(active)}
                onChange={(next) => onChange(active, next)}
              />
            </div>
            <SourceEditor
              path={active}
              doc={doc}
              files={files}
              onChange={(next) => onChange(active, next)}
              onOpenWikiLink={onOpenWikiLink}
              onFocus={onFocusPane}
              registerView={(v) => {
                viewRef.current = v;
                onRegisterView(v);
              }}
              aiRewrite={aiRewrite}
              aiIsLocal={aiIsLocal}
              notePrivacyMode={
                activePrivacy?.mode ?? (isPrivateNote(doc) ? "cloud-ai-private" : "public")
              }
              onRunSkill={onRunSkill}
            />
          </>
        ) : (
          <div className="editor-empty">
            <div className="editor-empty-inner">
              <div className="editor-empty-title">No note open</div>
              <div className="editor-empty-hint">
                Press <kbd>⌘N</kbd> to create one · <kbd>⌘O</kbd> to jump · <kbd>⌘P</kbd> for
                commands
              </div>
              <div className="editor-empty-hint">
                Inside a note, type <kbd>/</kbd> for headings, lists, and more.
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
