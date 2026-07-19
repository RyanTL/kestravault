import { useCallback, useEffect, useRef, useState } from "react";

// How many recently opened notes we keep per vault. The sidebar shows fewer;
// the extra slack means renames/deletes don't immediately empty the section.
const MAX_RECENTS = 8;

/**
 * Recently opened note paths, most recent first, persisted per-vault in
 * localStorage (same pattern as useBookmarks). Pure renderer convenience for
 * the sidebar's Recents section — never touches the filesystem.
 */
export function useRecents(vaultRoot: string) {
  const [recents, setRecents] = useState<string[]>([]);
  const key = vaultRoot ? `kestravault.recents:${vaultRoot}` : "";
  // The key we last loaded from — guards the persist effect so it never writes
  // one vault's list under another vault's key while the root is settling.
  const loadedKey = useRef("");

  // Load when the vault changes.
  useEffect(() => {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      setRecents(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setRecents([]);
    }
    loadedKey.current = key;
  }, [key]);

  // Persist on change, but only once we've loaded this vault's list.
  useEffect(() => {
    if (!key || loadedKey.current !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(recents));
    } catch {
      /* storage unavailable — recents simply won't persist this session */
    }
  }, [key, recents]);

  /** Move a note to the top of the list (called on every open). */
  const push = useCallback((path: string) => {
    setRecents((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENTS));
  }, []);

  // Drop a path — and, for a folder, everything under it — after a delete.
  const remove = useCallback((path: string) => {
    setRecents((prev) => prev.filter((p) => p !== path && !p.startsWith(path + "/")));
  }, []);

  // Follow a note (or a folder's contents) to its new path after a rename/move.
  const remap = useCallback((from: string, to: string) => {
    setRecents((prev) =>
      prev.map((p) =>
        p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p,
      ),
    );
  }, []);

  return { recents, push, remove, remap };
}

export type RecentsController = ReturnType<typeof useRecents>;
