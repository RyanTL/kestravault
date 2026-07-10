import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Bookmarked note paths, persisted per-vault in localStorage. Bookmarks are a
 * pure renderer convenience (like Obsidian's), not vault content, so they don't
 * touch the filesystem. Keyed by vault root so different vaults stay separate.
 */
export function useBookmarks(vaultRoot: string) {
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const key = vaultRoot ? `kestravault.bookmarks:${vaultRoot}` : "";
  // The key we last loaded from — guards the persist effect so it never writes
  // one vault's list under another vault's key while the root is settling.
  const loadedKey = useRef("");

  // Load when the vault changes.
  useEffect(() => {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      setBookmarks(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setBookmarks([]);
    }
    loadedKey.current = key;
  }, [key]);

  // Persist on change, but only once we've loaded this vault's list.
  useEffect(() => {
    if (!key || loadedKey.current !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(bookmarks));
    } catch {
      /* storage unavailable — bookmarks simply won't persist this session */
    }
  }, [key, bookmarks]);

  const has = useCallback((path: string) => bookmarks.includes(path), [bookmarks]);

  const toggle = useCallback((path: string) => {
    setBookmarks((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  // Drop a path — and, for a folder, everything under it — after a delete.
  const remove = useCallback((path: string) => {
    setBookmarks((prev) => prev.filter((p) => p !== path && !p.startsWith(path + "/")));
  }, []);

  // Follow a note (or a folder's contents) to its new path after a rename/move.
  const remap = useCallback((from: string, to: string) => {
    setBookmarks((prev) =>
      prev.map((p) =>
        p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p,
      ),
    );
  }, []);

  return { bookmarks, has, toggle, remove, remap };
}

export type BookmarksController = ReturnType<typeof useBookmarks>;
