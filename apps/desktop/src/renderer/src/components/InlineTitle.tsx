import { useEffect, useRef, useState } from "react";

const DEFAULT_NAME = "Untitled";

interface InlineTitleProps {
  /** Current note name (filename without extension). */
  name: string;
  /** Rename the file to this new name (same folder). */
  onRename: (next: string) => void;
  /** Move focus into the editor body (Enter / ArrowDown from the title). */
  onLeave?: () => void;
}

// The note title, shown as a big editable heading at the top of the note —
// Notion/Obsidian's "inline title". Editing it renames the file. A fresh
// "Untitled" note shows a placeholder instead of literal text, so new notes
// read as clean.
export function InlineTitle({ name, onRename, onLeave }: InlineTitleProps) {
  const [value, setValue] = useState(name === DEFAULT_NAME ? "" : name);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resync when switching notes.
  useEffect(() => {
    setValue(name === DEFAULT_NAME ? "" : name);
  }, [name]);

  function commit(): void {
    const next = value.trim();
    if (!next || next === name) return;
    onRename(next);
  }

  return (
    <textarea
      ref={ref}
      className="note-title"
      rows={1}
      spellCheck={false}
      placeholder={DEFAULT_NAME}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          commit();
          onLeave?.();
        }
      }}
    />
  );
}
