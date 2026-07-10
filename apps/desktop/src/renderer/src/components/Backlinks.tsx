import { useEffect, useState } from "react";
import { extractWikiLinks } from "@renderer/vault/markdown";
import { noteName, resolveWikiLink } from "@renderer/vault/paths";
import { ChevronRight } from "lucide-react";

interface BacklinksProps {
  currentPath: string;
  files: { name: string; path: string }[];
  onOpen: (path: string) => void;
}

interface Backlink {
  path: string;
  name: string;
}

// Notes that link to the current one ("Linked mentions"). Collapsed by default,
// like Obsidian — a quiet strip at the bottom that expands on click.
export function Backlinks({ currentPath, files, onOpen }: BacklinksProps) {
  const [links, setLinks] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: Backlink[] = [];
      for (const f of files) {
        if (f.path === currentPath) continue;
        let text: string;
        try {
          text = await window.api.vault.read(f.path);
        } catch {
          continue;
        }
        const hit = extractWikiLinks(text).some(
          (l) => resolveWikiLink(l.target, files) === currentPath,
        );
        if (hit) found.push({ path: f.path, name: noteName(f.path) });
      }
      if (!cancelled) setLinks(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath, files]);

  return (
    <div className={`backlinks${open ? " is-open" : ""}`}>
      <button className="backlinks-head" onClick={() => setOpen((v) => !v)}>
        <span className={`backlinks-caret${open ? " is-open" : ""}`}>
          <ChevronRight size={11} strokeWidth={1.8} aria-hidden />
        </span>
        <span>Linked mentions</span>
        {links.length > 0 ? <span className="backlinks-count">{links.length}</span> : null}
      </button>
      {open ? (
        links.length === 0 ? (
          <p className="backlinks-empty">No other notes link here yet.</p>
        ) : (
          <ul className="backlinks-list">
            {links.map((l) => (
              <li key={l.path}>
                <button className="backlink" onClick={() => onOpen(l.path)} title={l.path}>
                  {l.name}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
