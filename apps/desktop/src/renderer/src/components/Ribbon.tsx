// The left activity ribbon (Obsidian-style): a thin vertical strip of icon
// actions on the far edge of the workbench. Always visible — it's how you
// reach the file list, search, bookmarks, the daily note, the command palette,
// and new-note. The panel-left button doubles as the files toggle: it shows the
// file list and collapses the sidebar when the file list is already showing, so
// there's no separate (redundant) "Files" button.

import {
  PanelLeft,
  Search as SearchIcon,
  Bookmark as BookmarkIcon,
  Calendar as CalendarIcon,
  SquareTerminal,
  Share2,
  Settings as SettingsGearIcon,
  SquarePen,
} from "lucide-react";

// Shared stroke weight for the ribbon's lucide icons — a touch lighter than
// lucide's default (2) so the thin activity bar doesn't read as heavy.
const STROKE = 1.8;

// Exported so the AI chat panel's "New chat" button can reuse the exact same
// glyph as "New note" (they should read as the same action).
export function NewNoteIcon({ size = 18 }: { size?: number }) {
  return <SquarePen size={size} strokeWidth={STROKE} aria-hidden />;
}

interface RibbonProps {
  leftOpen: boolean;
  leftView: "files" | "bookmarks";
  graphOpen: boolean;
  onShowFiles: () => void;
  onShowBookmarks: () => void;
  onShowGraph: () => void;
  onSearch: () => void;
  onDailyNote: () => void;
  onCommand: () => void;
  onNewNote: () => void;
  onOpenSettings: () => void;
}

export function Ribbon({
  leftOpen,
  leftView,
  graphOpen,
  onShowFiles,
  onShowBookmarks,
  onShowGraph,
  onSearch,
  onDailyNote,
  onCommand,
  onNewNote,
  onOpenSettings,
}: RibbonProps) {
  // The panel-left button is the files toggle: it reveals the file list, and
  // collapses the sidebar when the file list is already the active view.
  const filesOn = leftOpen && leftView === "files";
  return (
    <nav className="ribbon" aria-label="Sidebar">
      <button
        className={`ribbon-btn${filesOn ? " is-on" : ""}`}
        title={filesOn ? "Collapse sidebar" : "Show files"}
        aria-pressed={filesOn}
        onClick={onShowFiles}
      >
        <PanelLeft size={18} strokeWidth={STROKE} aria-hidden />
      </button>

      <span className="ribbon-divider" />

      <button className="ribbon-btn" title="New note (⌘N)" onClick={onNewNote}>
        <NewNoteIcon />
      </button>
      <button className="ribbon-btn" title="Search (⌘⇧F)" onClick={onSearch}>
        <SearchIcon size={18} strokeWidth={STROKE} aria-hidden />
      </button>
      <button
        className={`ribbon-btn${leftOpen && leftView === "bookmarks" ? " is-on" : ""}`}
        title="Bookmarks"
        aria-pressed={leftOpen && leftView === "bookmarks"}
        onClick={onShowBookmarks}
      >
        <BookmarkIcon size={18} strokeWidth={STROKE} aria-hidden />
      </button>
      <button
        className={`ribbon-btn${graphOpen ? " is-on" : ""}`}
        title="Graph view (⌘⇧G)"
        aria-pressed={graphOpen}
        onClick={onShowGraph}
      >
        <Share2 size={18} strokeWidth={STROKE} aria-hidden />
      </button>
      <button className="ribbon-btn" title="Daily note" onClick={onDailyNote}>
        <CalendarIcon size={18} strokeWidth={STROKE} aria-hidden />
      </button>
      <button className="ribbon-btn" title="Open command palette (⌘P)" onClick={onCommand}>
        <SquareTerminal size={18} strokeWidth={STROKE} aria-hidden />
      </button>

      <span className="ribbon-spacer" />

      <button className="ribbon-btn" title="Settings (⌘,)" onClick={onOpenSettings}>
        <SettingsGearIcon size={18} strokeWidth={STROKE} aria-hidden />
      </button>
    </nav>
  );
}
