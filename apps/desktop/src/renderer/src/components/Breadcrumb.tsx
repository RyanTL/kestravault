import { noteName } from "@renderer/vault/paths";

interface BreadcrumbProps {
  /** Active note path, e.g. "wiki/concepts/ownership.md". */
  path: string;
  /** Reveal a folder or the note in the file tree. */
  onNavigate: (path: string) => void;
}

// The Notion-style breadcrumb row below the tabs: each folder segment plus the
// note name, on no background so it reads as the top of the note. Every segment
// is clickable and reveals that folder/note in the sidebar.
export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  const parts = path.split("/");
  const folders = parts.slice(0, -1).map((name, i) => ({
    name,
    full: parts.slice(0, i + 1).join("/"),
  }));
  const name = noteName(parts[parts.length - 1] ?? path);

  return (
    <div className="crumbs">
      <div className="crumbs-trail">
        {folders.map((f) => (
          <span className="crumb" key={f.full}>
            <button className="crumb-seg" onClick={() => onNavigate(f.full)}>
              {f.name}
            </button>
            <span className="crumb-sep">/</span>
          </span>
        ))}
        <button className="crumb-seg crumb-current" onClick={() => onNavigate(path)}>
          {name}
        </button>
      </div>
    </div>
  );
}
