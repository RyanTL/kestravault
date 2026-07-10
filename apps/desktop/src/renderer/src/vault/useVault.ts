import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrivacyMode, PrivacyTarget } from "@kestravault/core";
import type { VaultInfo, VaultNode } from "@renderer/vault/types";
import { flattenFiles, noteName, resolveWikiLink } from "@renderer/vault/paths";
import { recordActivity, recordEdit } from "@renderer/vault/activityLog";

export type SaveState = "saved" | "dirty" | "saving";

interface OpenDoc {
  content: string;
  saveState: SaveState;
}

const AUTOSAVE_MS = 500;

/**
 * Owns vault state for the renderer: the on-disk tree plus a map of *open*
 * documents keyed by path. Keying docs by path (rather than a single "selected
 * file") lets the same note appear in multiple tabs/panes and stay in sync, and
 * keeps autosave correct per file. Filesystem work happens in the main process
 * over the `window.api.vault` bridge.
 */
export function useVault() {
  const [root, setRoot] = useState("");
  const [tree, setTree] = useState<VaultNode[]>([]);
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [openDocs, setOpenDocs] = useState<Record<string, OpenDoc>>({});

  const files = useMemo(() => flattenFiles(tree), [tree]);

  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, string>());

  const refreshTree = useCallback(async () => {
    setTree(await window.api.vault.tree());
  }, []);

  const refreshVaults = useCallback(async () => {
    setVaults(await window.api.vault.list());
  }, []);

  const flushDoc = useCallback(async (path: string) => {
    const t = timers.current.get(path);
    if (t) {
      clearTimeout(t);
      timers.current.delete(path);
    }
    const content = pending.current.get(path);
    if (content === undefined) return;
    pending.current.delete(path);
    // If the doc was closed or renamed away before this (debounced) flush fired,
    // don't write — otherwise a stale timer recreates the old path on disk.
    if (!openDocsRef.current[path]) return;
    setOpenDocs((prev) =>
      prev[path] ? { ...prev, [path]: { content, saveState: "saving" } } : prev,
    );
    await window.api.vault.write(path, content);
    recordEdit(path, noteName(path)); // coalesced — at most one "edit" per note per few min
    setOpenDocs((prev) =>
      prev[path] ? { ...prev, [path]: { content, saveState: "saved" } } : prev,
    );
  }, []);
  const flushDocRef = useRef(flushDoc);
  flushDocRef.current = flushDoc;

  const flushAll = useCallback(async () => {
    await Promise.all([...pending.current.keys()].map((p) => flushDoc(p)));
  }, [flushDoc]);

  const loadDoc = useCallback(async (path: string) => {
    if (openDocsRef.current[path]) return;
    const content = await window.api.vault.read(path);
    setOpenDocs((prev) => (prev[path] ? prev : { ...prev, [path]: { content, saveState: "saved" } }));
  }, []);

  const editDoc = useCallback((path: string, next: string) => {
    setOpenDocs((prev) => ({ ...prev, [path]: { content: next, saveState: "dirty" } }));
    pending.current.set(path, next);
    const existing = timers.current.get(path);
    if (existing) clearTimeout(existing);
    timers.current.set(
      path,
      setTimeout(() => void flushDocRef.current(path), AUTOSAVE_MS),
    );
  }, []);

  const closeDoc = useCallback(
    async (path: string) => {
      await flushDoc(path);
      setOpenDocs((prev) => {
        if (!prev[path]) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [flushDoc],
  );

  const createNote = useCallback(
    async (dir = "", name = "Untitled"): Promise<string> => {
      const rel = `${dir ? dir + "/" : ""}${name}.md`;
      // Start clean — the filename is the title (shown as the editable inline
      // title + breadcrumb), so we don't inject a "# Title" heading into the body.
      const created = await window.api.vault.create(rel, "");
      recordActivity({ type: "create", path: created, title: noteName(created) });
      await refreshTree();
      await loadDoc(created);
      return created;
    },
    [loadDoc, refreshTree],
  );

  const createFolder = useCallback(
    async (dir = "", name = "New folder"): Promise<string> => {
      const created = await window.api.vault.createDir(`${dir ? dir + "/" : ""}${name}`);
      await refreshTree();
      return created;
    },
    [refreshTree],
  );

  // Rename, keeping any open doc under the new path. Returns the actual new path.
  const rename = useCallback(
    async (path: string, nextPath: string): Promise<string> => {
      await flushDoc(path);
      const actual = await window.api.vault.rename(path, nextPath);
      recordActivity({ type: "rename", path: actual, title: noteName(actual) });
      setOpenDocs((prev) => {
        if (!prev[path]) return prev;
        const next = { ...prev };
        next[actual] = next[path]!;
        delete next[path];
        return next;
      });
      await refreshTree();
      return actual;
    },
    [flushDoc, refreshTree],
  );

  /** Move a file into a new directory (drag-and-drop in the tree). Returns the
   *  new path, or the original if nothing changed. */
  const move = useCallback(
    async (path: string, targetDir: string): Promise<string> => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const next = `${targetDir ? targetDir + "/" : ""}${name}`;
      if (next === path) return path;
      return rename(path, next);
    },
    [rename],
  );

  const remove = useCallback(
    async (path: string): Promise<void> => {
      await window.api.vault.remove(path);
      recordActivity({ type: "delete", path, title: noteName(path) });
      pending.current.delete(path);
      setOpenDocs((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key === path || key.startsWith(path + "/")) delete next[key];
        }
        return next;
      });
      await refreshTree();
    },
    [refreshTree],
  );

  const setPrivacy = useCallback(
    async (path: string, target: PrivacyTarget, mode: PrivacyMode): Promise<void> => {
      if (target === "file") await flushDoc(path);
      await window.api.vault.setPrivacy(path, target, mode);
      if (target === "file" && openDocsRef.current[path]) {
        const content = await window.api.vault.read(path);
        setOpenDocs((prev) =>
          prev[path] ? { ...prev, [path]: { content, saveState: "saved" } } : prev,
        );
      }
      await refreshTree();
    },
    [flushDoc, refreshTree],
  );

  const clearPrivacy = useCallback(
    async (path: string, target: PrivacyTarget): Promise<void> => {
      if (target === "file") await flushDoc(path);
      await window.api.vault.clearPrivacy(path, target);
      if (target === "file" && openDocsRef.current[path]) {
        const content = await window.api.vault.read(path);
        setOpenDocs((prev) =>
          prev[path] ? { ...prev, [path]: { content, saveState: "saved" } } : prev,
        );
      }
      await refreshTree();
    },
    [flushDoc, refreshTree],
  );

  /** Resolve a wikilink (creating the note if missing) and return its path. */
  const openWikiLink = useCallback(
    async (target: string): Promise<string> => {
      const existing = resolveWikiLink(target, flattenFiles(await window.api.vault.tree()));
      if (existing) {
        await loadDoc(existing);
        return existing;
      }
      return createNote("", noteName(target));
    },
    [createNote, loadDoc],
  );

  // ── Multiple vaults ──
  // Entering a different vault: drop all per-vault doc state (open docs belong
  // to the vault we're leaving), then point everything at the new root. Pending
  // edits to the old vault should already be flushed by the caller.
  const applyRoot = useCallback(
    async (newRoot: string) => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
      pending.current.clear();
      setOpenDocs({});
      setRoot(newRoot);
      await refreshTree();
      await refreshVaults();
    },
    [refreshTree, refreshVaults],
  );

  /** Switch to a known vault by its path. */
  const switchVault = useCallback(
    async (path: string): Promise<void> => {
      await applyRoot(await window.api.vault.switch(path));
    },
    [applyRoot],
  );

  /** Pick an existing folder to open as a vault. Returns the new root, or null
   *  if the picker was cancelled. */
  const openVaultFolder = useCallback(async (): Promise<string | null> => {
    const newRoot = await window.api.vault.add();
    if (newRoot) await applyRoot(newRoot);
    return newRoot;
  }, [applyRoot]);

  /** Pick a folder to create a new (seeded) vault. Returns the new root, or null. */
  const createVault = useCallback(async (): Promise<string | null> => {
    const newRoot = await window.api.vault.createVault();
    if (newRoot) await applyRoot(newRoot);
    return newRoot;
  }, [applyRoot]);

  /** Forget a vault from the list (the current vault can't be removed). */
  const removeVault = useCallback(async (path: string): Promise<void> => {
    setVaults(await window.api.vault.removeVault(path));
  }, []);

  // Initial load.
  useEffect(() => {
    void (async () => {
      setRoot(await window.api.vault.root());
      await refreshTree();
      await refreshVaults();
    })();
  }, [refreshTree, refreshVaults]);

  // External changes (Finder/Obsidian/git): refresh the tree, and reload any
  // open doc that has no unsaved edits to lose.
  useEffect(() => {
    return window.api.vault.onChanged(() => {
      void refreshTree();
      for (const [path, doc] of Object.entries(openDocsRef.current)) {
        if (doc.saveState !== "saved" || pending.current.has(path)) continue;
        void window.api.vault.read(path).then(
          (text) =>
            setOpenDocs((prev) =>
              prev[path]?.saveState === "saved"
                ? { ...prev, [path]: { content: text, saveState: "saved" } }
                : prev,
            ),
          () => {
            /* removed externally; tree refresh handles it */
          },
        );
      }
    });
  }, [refreshTree]);

  // Save on quit / reload so the last keystrokes aren't lost.
  useEffect(() => {
    const onUnload = (): void => {
      for (const [p, c] of pending.current) void window.api.vault.write(p, c);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  return {
    root,
    tree,
    files,
    vaults,
    openDocs,
    loadDoc,
    editDoc,
    closeDoc,
    flushAll,
    refreshTree,
    createNote,
    createFolder,
    rename,
    move,
    remove,
    setPrivacy,
    clearPrivacy,
    openWikiLink,
    switchVault,
    openVaultFolder,
    createVault,
    removeVault,
  };
}

export type VaultController = ReturnType<typeof useVault>;
