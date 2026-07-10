import { useEffect, useMemo, useRef, useState } from "react";
import { noteName, dirName } from "@renderer/vault/paths";

interface QuickSwitcherProps {
  files: { name: string; path: string }[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** Subsequence (fuzzy) match — every query char appears in order. */
function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function QuickSwitcher({ files, onOpen, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const matches = files.filter((f) => fuzzy(query, noteName(f.path)) || fuzzy(query, f.path));
    // Prefer name matches, then shorter paths.
    return matches
      .sort((a, b) => {
        const an = noteName(a.path).toLowerCase().includes(query.toLowerCase()) ? 0 : 1;
        const bn = noteName(b.path).toLowerCase().includes(query.toLowerCase()) ? 0 : 1;
        return an - bn || a.path.length - b.path.length;
      })
      .slice(0, 50);
  }, [files, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);

  function choose(i: number): void {
    const hit = results[i];
    if (hit) {
      onOpen(hit.path);
      onClose();
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to note…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="palette-list">
          {results.length === 0 ? (
            <li className="palette-empty">No matching notes</li>
          ) : (
            results.map((f, i) => (
              <li
                key={f.path}
                className={`palette-item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="palette-name">{noteName(f.path)}</span>
                {dirName(f.path) ? <span className="palette-dir">{dirName(f.path)}</span> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
