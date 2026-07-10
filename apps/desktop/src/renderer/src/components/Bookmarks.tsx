import { noteName, dirName } from "@renderer/vault/paths";
import { Bookmark } from "lucide-react";

function BookmarkIcon() {
  return <Bookmark size={15} strokeWidth={1.8} aria-hidden />;
}

interface BookmarksProps {
  bookmarks: string[];
  files: { name: string; path: string }[];
  selectedPath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

// The left-sidebar "Bookmarks" view (the ribbon's bookmark icon switches to it).
// Lists bookmarked notes that still exist on disk; click to open, × to remove.
export function Bookmarks({ bookmarks, files, selectedPath, onOpen, onRemove }: BookmarksProps) {
  const fileSet = new Set(files.map((f) => f.path));
  const items = bookmarks.filter((p) => fileSet.has(p));

  return (
    <nav className="pane pane-left">
      <header className="pane-header">
        <span className="pane-title">Bookmarks</span>
      </header>
      <div className="tree-scroll">
        {items.length === 0 ? (
          <p className="side-empty side-empty-pad">
            No bookmarks yet. Right-click a note in the file list and choose <em>Bookmark</em>.
          </p>
        ) : (
          <ul className="bm-list">
            {items.map((p) => (
              <li
                key={p}
                className={`bm-row${p === selectedPath ? " is-selected" : ""}`}
                title={p}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onOpen(p);
                }}
              >
                <span className="bm-icon">
                  <BookmarkIcon />
                </span>
                <span className="bm-main">
                  <span className="bm-name">{noteName(p)}</span>
                  {dirName(p) ? <span className="bm-dir">{dirName(p)}</span> : null}
                </span>
                <button
                  className="bm-remove"
                  title="Remove bookmark"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(p);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
