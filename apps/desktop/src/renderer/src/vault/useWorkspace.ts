import { useCallback, useMemo, useState } from "react";

// A pane is one editor group with its own tabs. We support up to two panes
// side-by-side (Obsidian-style "Split right"); each pane tracks its open tabs
// and which one is active. File opens always target the focused pane.

export interface Pane {
  id: string;
  tabs: string[];
  active: string | null;
}

let paneSeq = 1;
const newId = (): string => `pane-${++paneSeq}`;

export function useWorkspace() {
  const [panes, setPanes] = useState<Pane[]>([{ id: "pane-1", tabs: [], active: null }]);
  const [activePaneId, setActivePaneId] = useState("pane-1");

  /** Every path open in any pane (for the vault's load/close lifecycle). */
  const openPaths = useMemo(() => {
    const set = new Set<string>();
    for (const p of panes) for (const t of p.tabs) set.add(t);
    return set;
  }, [panes]);

  const focusPane = useCallback((id: string) => setActivePaneId(id), []);

  // Open a path in the focused pane (or a specific pane), focusing it.
  const open = useCallback(
    (path: string, paneId?: string) => {
      const target = paneId ?? activePaneId;
      setPanes((prev) =>
        prev.map((p) =>
          p.id === target
            ? { ...p, tabs: p.tabs.includes(path) ? p.tabs : [...p.tabs, path], active: path }
            : p,
        ),
      );
      setActivePaneId(target);
    },
    [activePaneId],
  );

  const setActiveTab = useCallback((paneId: string, path: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, active: path } : p)));
    setActivePaneId(paneId);
  }, []);

  // Close a tab; if it was the last tab in a non-primary pane, drop the pane.
  const closeTab = useCallback((paneId: string, path: string) => {
    setPanes((prev) => {
      const next = prev
        .map((p) => {
          if (p.id !== paneId) return p;
          const tabs = p.tabs.filter((t) => t !== path);
          const active =
            p.active === path ? (tabs[tabs.length - 1] ?? null) : p.active;
          return { ...p, tabs, active };
        })
        .filter((p, i) => i === 0 || p.tabs.length > 0); // keep at least the first pane
      return next.length ? next : [{ id: "pane-1", tabs: [], active: null }];
    });
  }, []);

  // Split: add a second pane carrying the active pane's current tab.
  const splitRight = useCallback(() => {
    setPanes((prev) => {
      if (prev.length >= 2) return prev;
      const src = prev.find((p) => p.id === activePaneId) ?? prev[0];
      const carry = src?.active ?? null;
      const id = newId();
      setActivePaneId(id);
      return [...prev, { id, tabs: carry ? [carry] : [], active: carry }];
    });
  }, [activePaneId]);

  const closePane = useCallback(
    (paneId: string) => {
      setPanes((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((p) => p.id !== paneId);
        if (activePaneId === paneId && next[0]) setActivePaneId(next[0].id);
        return next;
      });
    },
    [activePaneId],
  );

  // Drop tabs whose files no longer exist (after delete/rename), and remap paths.
  const remapTab = useCallback((from: string, to: string) => {
    setPanes((prev) =>
      prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t === from ? to : t)),
        active: p.active === from ? to : p.active,
      })),
    );
  }, []);

  // Drag a tab to a new position, within its pane or into the other pane.
  const moveTab = useCallback(
    (fromPaneId: string, path: string, toPaneId: string, toIndex: number | null) => {
      setPanes((prev) => {
        let next = prev.map((p) => {
          if (p.id !== toPaneId) return p;
          const tabs = p.tabs.filter((t) => t !== path);
          const idx = toIndex == null ? tabs.length : Math.max(0, Math.min(toIndex, tabs.length));
          tabs.splice(idx, 0, path);
          return { ...p, tabs, active: path };
        });
        if (fromPaneId !== toPaneId) {
          next = next.map((p) => {
            if (p.id !== fromPaneId) return p;
            const tabs = p.tabs.filter((t) => t !== path);
            const active = p.active === path ? (tabs[tabs.length - 1] ?? null) : p.active;
            return { ...p, tabs, active };
          });
        }
        next = next.filter((p, i) => i === 0 || p.tabs.length > 0);
        return next.length ? next : [{ id: "pane-1", tabs: [], active: null }];
      });
      setActivePaneId(toPaneId);
    },
    [],
  );

  // Wipe the workspace back to a single empty pane — used when switching vaults,
  // since every open tab points at the vault we're leaving.
  const reset = useCallback(() => {
    setPanes([{ id: "pane-1", tabs: [], active: null }]);
    setActivePaneId("pane-1");
  }, []);

  const dropPath = useCallback((path: string) => {
    setPanes((prev) => {
      const next = prev
        .map((p) => {
          const tabs = p.tabs.filter((t) => t !== path && !t.startsWith(path + "/"));
          const active = tabs.includes(p.active ?? "") ? p.active : (tabs[tabs.length - 1] ?? null);
          return { ...p, tabs, active };
        })
        .filter((p, i) => i === 0 || p.tabs.length > 0);
      return next.length ? next : [{ id: "pane-1", tabs: [], active: null }];
    });
  }, []);

  return {
    panes,
    activePaneId,
    openPaths,
    open,
    focusPane,
    setActiveTab,
    closeTab,
    splitRight,
    closePane,
    remapTab,
    dropPath,
    moveTab,
    reset,
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspace>;
