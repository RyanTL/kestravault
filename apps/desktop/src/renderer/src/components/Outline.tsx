import { useMemo } from "react";

interface OutlineProps {
  content: string;
  onJump: (line: number) => void;
}

interface Heading {
  level: number;
  text: string;
  line: number; // 1-based, matching the editor document
}

// Parse ATX headings from the note, skipping YAML frontmatter and fenced code.
function parseHeadings(content: string): Heading[] {
  const lines = content.split("\n");
  const out: Heading[] = [];
  let inFence = false;
  let inFrontmatter = lines[0]?.trim() === "---";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inFrontmatter) {
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i + 1 });
  }
  return out;
}

export function Outline({ content, onJump }: OutlineProps) {
  const headings = useMemo(() => parseHeadings(content), [content]);
  const minLevel = useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings],
  );

  if (headings.length === 0) {
    return <p className="side-empty">No headings in this note.</p>;
  }

  return (
    <ul className="outline-list">
      {headings.map((h, i) => (
        <li key={`${h.line}-${i}`}>
          <button
            className="outline-item"
            style={{ paddingLeft: `${10 + (h.level - minLevel) * 14}px` }}
            onClick={() => onJump(h.line)}
            title={h.text}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
