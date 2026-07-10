import { useEffect, useMemo, useRef, useState } from "react";
import { noteName, dirName } from "@renderer/vault/paths";
import { searchLines, type SearchHit } from "@renderer/vault/search";
import { AiAvatar, AiIcon } from "@renderer/components/AiIcons";

interface SearchModalProps {
  files: { name: string; path: string }[];
  onOpen: (path: string) => void;
  onAskAI: (query: string) => void;
  onClose: () => void;
}

type Row =
  | { kind: "ask"; query: string }
  | { kind: "page"; path: string }
  | { kind: "hit"; hit: SearchHit };

// Notion-style "Search or ask AI": an Ask-AI row up top, then matching pages,
// then full-text hits. Plain note browsing when the query is empty.
export function SearchModal({ files, onOpen, onAskAI, onClose }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim();

  useEffect(() => inputRef.current?.focus(), []);

  // Full-text scan (debounced), like before.
  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void searchLines(files, q, 40).then((found) => {
        if (!cancelled) setHits(found);
      });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, files]);

  const pages = useMemo(() => {
    if (!q) return files.slice(0, 7); // "Jump to" — first notes when empty
    const lower = q.toLowerCase();
    return files.filter((f) => noteName(f.path).toLowerCase().includes(lower)).slice(0, 6);
  }, [q, files]);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (q) list.push({ kind: "ask", query: q });
    for (const p of pages) list.push({ kind: "page", path: p.path });
    // Don't repeat a note in full-text when its title already matched.
    const titleHit = new Set(pages.map((p) => p.path));
    for (const h of hits) {
      if (!titleHit.has(h.path)) list.push({ kind: "hit", hit: h });
    }
    return list;
  }, [q, pages, hits]);

  // Default selection: first page match if any, else the Ask-AI row.
  useEffect(() => {
    const firstPage = rows.findIndex((r) => r.kind === "page");
    setActive(firstPage >= 0 ? firstPage : 0);
  }, [rows]);

  function run(row: Row): void {
    if (row.kind === "ask") onAskAI(row.query);
    else if (row.kind === "page") {
      onOpen(row.path);
      onClose();
    } else {
      onOpen(row.hit.path);
      onClose();
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) run(row);
    }
  }

  function highlight(text: string): React.ReactNode {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1 || !q) return text.slice(0, 150);
    const start = Math.max(0, idx - 28);
    return (
      <>
        {start > 0 ? "…" : ""}
        {text.slice(start, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length, idx + q.length + 80)}
      </>
    );
  }

  let rowIndex = -1;
  const renderRow = (row: Row): React.ReactNode => {
    rowIndex++;
    const idx = rowIndex;
    const isActive = idx === active;
    const common = {
      className: `srch-row${isActive ? " is-active" : ""}`,
      onMouseEnter: () => setActive(idx),
      onClick: () => run(row),
    };
    if (row.kind === "ask") {
      return (
        <li key="ask" {...common}>
          <AiAvatar size={20} />
          <div className="srch-row-main">
            <span className="srch-ask">Ask AI: “{row.query}”</span>
          </div>
          <span className="srch-enter">↵</span>
        </li>
      );
    }
    if (row.kind === "page") {
      const dir = dirName(row.path);
      return (
        <li key={`p:${row.path}`} {...common}>
          <span className="srch-icon">
            <AiIcon name="doc" />
          </span>
          <div className="srch-row-main">
            <span className="srch-name">{noteName(row.path)}</span>
            {dir ? <span className="srch-dir">in {dir}</span> : null}
          </div>
        </li>
      );
    }
    const h = row.hit;
    return (
      <li key={`h:${h.path}:${h.line}`} {...common}>
        <span className="srch-icon srch-icon-dim">
          <AiIcon name="doc" />
        </span>
        <div className="srch-row-main">
          <span className="srch-name">{noteName(h.path)}</span>
          <span className="srch-snippet">{highlight(h.text)}</span>
        </div>
      </li>
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette palette-wide" onClick={(e) => e.stopPropagation()}>
        <div className="srch-input-wrap">
          <span className="srch-input-icon">
            <AiIcon name="search" />
          </span>
          <input
            ref={inputRef}
            className="palette-input srch-input"
            placeholder="Search or ask AI…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="palette-list srch-list">
          {!q ? <li className="srch-section">Jump to</li> : null}
          {rows.length === 0 ? (
            <li className="palette-empty">{q ? "No matches" : "No notes yet"}</li>
          ) : (
            rows.map(renderRow)
          )}
        </ul>
      </div>
    </div>
  );
}
