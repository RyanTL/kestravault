import { useCallback, useEffect, useState } from "react";
import type { VaultNode } from "@renderer/vault/types";
import { baseName } from "@renderer/vault/paths";

// Manual file-tree ordering lives in the renderer, not on disk: the vault is a
// real folder of markdown and we don't want to litter it with sidecar order
// files. Like the panel widths, the order is a per-machine UI preference kept in
// localStorage. Each entry maps a folder's path ("" = vault root) to the
// ordered list of its child *basenames* (so the order survives a parent rename
// and never clashes between a folder "foo" and a note "foo.md").
export type OrderMap = Record<string, string[]>;

const STORAGE_KEY = "kestravault.tree.order";

function load(): OrderMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as OrderMap) : {};
  } catch {
    return {};
  }
}

// Default sibling order, matching the main process: folders first, then files,
// each alphabetical (case-insensitive). Used as the baseline and as the
// tiebreaker for entries that have no manual position yet.
function defaultCompare(a: VaultNode, b: VaultNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Apply the saved manual order to a tree (recursively). Within each folder,
 * children that appear in the saved list come first, in that order; anything
 * new (created since the order was saved) keeps the default folders-first
 * alphabetical order after them.
 */
export function sortTree(nodes: VaultNode[], order: OrderMap, dir = ""): VaultNode[] {
  const saved = order[dir];
  const sorted = [...nodes].sort(defaultCompare);
  if (saved && saved.length) {
    const rank = new Map(saved.map((name, i) => [name, i]));
    sorted.sort((a, b) => {
      const ia = rank.get(baseName(a.path));
      const ib = rank.get(baseName(b.path));
      if (ia != null && ib != null) return ia - ib;
      if (ia != null) return -1;
      if (ib != null) return 1;
      return defaultCompare(a, b);
    });
  }
  return sorted.map((n) =>
    n.kind === "dir" ? { ...n, children: sortTree(n.children, order, n.path) } : n,
  );
}

export function useTreeOrder() {
  const [order, setOrder] = useState<OrderMap>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
    } catch {
      /* storage full / unavailable — ordering just won't persist */
    }
  }, [order]);

  /**
   * Persist a sibling order for a single folder. `siblings` is that folder's
   * children basenames in their *current displayed order*; `moved` is spliced in
   * next to a reference:
   *  - ref === null  → append to the end (used when dropping *into* a folder).
   *  - side "before" → just ahead of `ref`; "after" → just behind it.
   * When the item came from a different folder, pass `prune` to drop its old
   * name from that folder's saved order (keeps storage tidy after a move).
   */
  const place = useCallback(
    (
      dir: string,
      siblings: string[],
      moved: string,
      ref: string | null,
      side: "before" | "after",
      prune?: { dir: string; name: string },
    ) => {
      setOrder((prev) => {
        const next = { ...prev };
        const oldList = prune ? next[prune.dir] : undefined;
        if (prune && oldList) {
          next[prune.dir] = oldList.filter((b) => b !== prune.name);
        }
        const bases = siblings.filter((b) => b !== moved);
        const at = ref == null ? bases.length : bases.indexOf(ref);
        const insertAt = at < 0 ? bases.length : side === "after" ? at + 1 : at;
        bases.splice(insertAt, 0, moved);
        next[dir] = bases;
        return next;
      });
    },
    [],
  );

  return { order, place };
}
