import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrivacyMode, PrivacyTarget, EffectivePrivacy } from "@kestravault/core";
import type { VaultInfo, VaultNode } from "@renderer/vault/types";
import { baseName, dirName, noteName } from "@renderer/vault/paths";
import { VaultSwitcher } from "@renderer/components/VaultSwitcher";
import {
  sortTree,
  useTreeOrder,
  type TreeSortMode,
} from "@renderer/vault/useTreeOrder";
import {
  ArrowDownAZ,
  Check,
  ChevronRight,
  ChevronsDownUp,
  CircleHelp,
  CloudOff,
  FileText,
  FolderPlus,
  Lock,
  Plus,
  SquarePen,
  SquareCheckBig,
  Trash2,
  Users,
} from "lucide-react";

function ChevronIcon() {
  return <ChevronRight size={12} strokeWidth={1.8} aria-hidden />;
}

// Closed padlock shown on the right of a private note's row — the persistent
// cue that its body is hidden from a remote AI (see notePrivacy.ts).
function PrivacyTreeIcon({ privacy }: { privacy: EffectivePrivacy }) {
  const inherited = privacy.inherited ? " inherited" : "";
  if (privacy.mode === "local-only") {
    return (
      <CloudOff
        className={`tree-lock${inherited}`}
        size={12}
        strokeWidth={1.7}
        aria-label="Local only"
      />
    );
  }
  if (privacy.mode === "cloud-ai-private") {
    return (
      <Lock
        className={`tree-lock${inherited}`}
        size={12}
        strokeWidth={1.7}
        aria-label="AI private"
      />
    );
  }
  return null;
}

function FolderPlusIcon() {
  return <FolderPlus size={18} strokeWidth={1.7} aria-hidden />;
}

function NotePlusIcon() {
  return <SquarePen size={18} strokeWidth={1.7} aria-hidden />;
}

// One collapsible sidebar group (Notion's Recents / Shared / Private). The
// header row toggles the body; hover reveals the caret and any actions.
function Section({
  label,
  collapsed,
  onToggle,
  actions,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="side-section">
      <div
        className="side-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="side-section-label">{label}</span>
        <span className={`side-section-caret${collapsed ? " is-collapsed" : ""}`}>
          <ChevronRight size={11} strokeWidth={2} aria-hidden />
        </span>
        {actions ? (
          <div className="side-section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </div>
      {!collapsed ? children : null}
    </section>
  );
}

// Which sidebar sections are collapsed, remembered across sessions.
const SECTIONS_KEY = "kestravault.side.collapsed";

function loadCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function collectFolderPaths(nodes: VaultNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "dir" ? [node.path, ...collectFolderPaths(node.children)] : [],
  );
}

const SORT_OPTIONS: { mode: TreeSortMode; label: string }[] = [
  { mode: "name-asc", label: "File name (A to Z)" },
  { mode: "name-desc", label: "File name (Z to A)" },
  { mode: "custom", label: "Custom order" },
];

interface FileExplorerProps {
  tree: VaultNode[];
  vaultName: string;
  /** Known vaults, for the header's switcher dropdown. */
  vaults: VaultInfo[];
  onSwitchVault: (path: string) => void;
  onOpenVaultFolder: () => void;
  onCreateVault: () => void;
  onRemoveVault: (path: string) => void;
  selectedPath: string | null;
  /** Folder or note to reveal (expand + scroll + flash); bump `revealNonce` to retrigger. */
  revealPath: string | null;
  revealNonce: number;
  /** Whether a note path is bookmarked (drives the context-menu label). */
  isBookmarked: (path: string) => boolean;
  onSelect: (path: string) => void;
  onCreateNote: (dir?: string) => Promise<string>;
  onCreateFolder: (dir?: string) => Promise<string>;
  onRename: (path: string, nextPath: string) => Promise<void>;
  /** Move a note into another folder; resolves to the path it actually landed at. */
  onMove: (path: string, targetDir: string) => Promise<string>;
  onDelete: (path: string) => Promise<void>;
  onToggleBookmark: (path: string) => void;
  onSetPrivacy: (path: string, target: PrivacyTarget, mode: PrivacyMode) => Promise<void>;
  onClearPrivacy: (path: string, target: PrivacyTarget) => Promise<void>;
  onReveal: (path?: string) => void;
  /** Name of the linked shared workspace, or null when the vault isn't shared. */
  sharedWorkspaceName: string | null;
  /** Open the sharing settings (invite people / manage the workspace). */
  onStartCollaborating: () => void;
  /** Recently opened notes, most recent first (already filtered to existing files). */
  recentPaths: string[];
  /** Whether the My Tasks view is showing in the main area. */
  tasksOpen: boolean;
  /** Open the My Tasks view in the main area. */
  onOpenTasks: () => void;
  /** Open the command palette (the Help menu's "Keyboard shortcuts" entry). */
  onOpenCommandPalette: () => void;
}

// Drag-and-drop to move/reorder notes. We carry the note's path on a private
// MIME type so it never clashes with the editor's tab drags.
const MOVE_MIME = "application/x-kestravault-move";

interface MenuState {
  x: number;
  y: number;
  node: VaultNode | null; // null = root / empty space
}

interface Size {
  width: number;
  height: number;
}

/** Keep a context menu wholly inside the window, opening it upward/leftward as needed. */
export function fitMenuToViewport(
  origin: { x: number; y: number },
  menuSize: Size,
  viewportSize: Size,
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewportSize.width - menuSize.width - margin);
  const maxY = Math.max(margin, viewportSize.height - menuSize.height - margin);
  return {
    x: Math.min(Math.max(origin.x, margin), maxX),
    y: Math.min(Math.max(origin.y, margin), maxY),
  };
}

// Where a drop will land: next to a reference row (reorder) or inside a folder.
//  - "before"/"after": insert as a sibling, just above/below `ref`, in `dir`.
//  - "into": drop inside the folder `dir` (ref === dir).
// `dir` is the resulting parent folder ("" = vault root).
interface DropIntent {
  ref: string;
  dir: string;
  mode: "before" | "after" | "into";
}

export function FileExplorer(props: FileExplorerProps) {
  const { tree, vaultName, selectedPath, revealPath, revealNonce, onSelect, onReveal } = props;
  const { order, place, sortMode, setSortMode } = useTreeOrder();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Collapsed sidebar sections (Recents / Shared / Private), persisted.
  const [closedSections, setClosedSections] = useState<Set<string>>(loadCollapsedSections);
  // The small panel popped up from the bottom menu ("trash" or "help").
  const [bottomPanel, setBottomPanel] = useState<"trash" | "help" | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Multi-selection of note paths (Cmd/Ctrl+click toggles, Shift+click ranges).
  // Empty means "no multi-selection"; the single open note lives in selectedPath.
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  // The row a Shift-range extends from (last plainly/Cmd-clicked note).
  const anchorRef = useRef<string | null>(null);
  // Live drop target while dragging (drives the insertion line / folder ring).
  const [drop, setDrop] = useState<DropIntent | null>(null);
  // The node currently being dragged (dimmed) and the row to briefly flash.
  const [dragging, setDragging] = useState<VaultNode | null>(null);
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const sortRef = useRef<HTMLDivElement | null>(null);
  // A floating "lifted" chip used as the native drag image while moving a note.
  const dragGhostRef = useRef<HTMLElement | null>(null);

  // The tree with the user's manual ordering applied on top of the on-disk
  // (folders-first, alphabetical) order.
  const orderedTree = useMemo(() => sortTree(tree, order, "", sortMode), [tree, order, sortMode]);
  const folderPaths = useMemo(() => collectFolderPaths(tree), [tree]);

  useEffect(() => {
    if (!sortOpen) return;
    const close = (event: MouseEvent): void => {
      if (!sortRef.current?.contains(event.target as Node)) setSortOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSortOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [sortOpen]);

  // Each folder's children in display order, keyed by folder path ("" = root).
  // Used to compute insertion indices when reordering.
  const childrenByDir = useMemo(() => {
    const m = new Map<string, VaultNode[]>();
    m.set("", orderedTree);
    const walk = (ns: VaultNode[]): void => {
      for (const n of ns)
        if (n.kind === "dir") {
          m.set(n.path, n.children);
          walk(n.children);
        }
    };
    walk(orderedTree);
    return m;
  }, [orderedTree]);

  // Rows in top-to-bottom display order, skipping the contents of collapsed
  // folders — the visual order a Shift-range walks between two notes.
  const visibleRows = useMemo(() => {
    const out: VaultNode[] = [];
    const walk = (ns: VaultNode[]): void => {
      for (const n of ns) {
        out.push(n);
        if (n.kind === "dir" && !collapsed.has(n.path)) walk(n.children);
      }
    };
    walk(orderedTree);
    return out;
  }, [orderedTree, collapsed]);

  // Row → its index in visibleRows, for O(1) neighbour lookups when deciding
  // which corners of a selected run to round.
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleRows.forEach((n, i) => m.set(n.path, i));
    return m;
  }, [visibleRows]);

  function isRowSelected(path: string): boolean {
    return path === selectedPath || multiSel.has(path);
  }

  // Note paths visible between two rows (inclusive), in display order.
  function fileRangeBetween(a: string | null, b: string): string[] {
    const idxB = visibleRows.findIndex((n) => n.path === b);
    const idxA = a ? visibleRows.findIndex((n) => n.path === a) : -1;
    if (idxB < 0 || idxA < 0) return [b];
    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    return visibleRows
      .slice(lo, hi + 1)
      .filter((n) => n.kind === "file")
      .map((n) => n.path);
  }

  function removeDragGhost(): void {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
  }
  // Make sure a half-finished drag never leaves the ghost orphaned in the DOM.
  useEffect(() => removeDragGhost, []);

  // FLIP: smoothly slide rows from their previous position to the new one when
  // the order changes (reorder/move) or a folder expands/collapses.
  const prevTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const base = container.getBoundingClientRect().top - container.scrollTop;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".tree-row[data-path]"));
    const tops = new Map<string, number>();
    for (const el of rows) {
      const path = el.dataset.path!;
      const top = el.getBoundingClientRect().top - base; // scroll-independent
      tops.set(path, top);
      if (reduce) continue;
      const prev = prevTops.current.get(path);
      if (prev == null) continue;
      const dy = prev - top;
      if (Math.abs(dy) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      void el.getBoundingClientRect(); // force reflow so the next change animates
      el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      el.style.transform = "";
      const clear = (): void => {
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", clear);
      };
      el.addEventListener("transitionend", clear);
    }
    prevTops.current = tops;
  }, [orderedTree, collapsed]);

  // Persist which sections are collapsed.
  useEffect(() => {
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections]));
    } catch {
      /* storage unavailable — collapse state simply won't persist */
    }
  }, [closedSections]);

  function toggleSection(id: string): void {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Close the trash/help popover on any outside interaction or Escape.
  useEffect(() => {
    if (!bottomPanel) return;
    const close = (e: MouseEvent): void => {
      const el = e.target as HTMLElement;
      if (!el.closest(".side-pop") && !el.closest(".side-bottom")) setBottomPanel(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setBottomPanel(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [bottomPanel]);

  // Reveal a folder/note: expand its ancestors, scroll it into view, flash it.
  useEffect(() => {
    if (!revealPath) return;
    // The tree lives in the Private section — make sure it's showing.
    setClosedSections((prev) => {
      if (!prev.has("private")) return prev;
      const next = new Set(prev);
      next.delete("private");
      return next;
    });
    const parts = revealPath.split("/");
    const toOpen: string[] = [];
    for (let i = 1; i < parts.length; i++) toOpen.push(parts.slice(0, i).join("/"));
    if (!revealPath.endsWith(".md")) toOpen.push(revealPath); // expand the folder itself
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of toOpen) next.delete(p);
      return next;
    });
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(revealPath)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
      setFlashPath(revealPath);
    });
    return () => cancelAnimationFrame(raf);
  }, [revealNonce, revealPath]);

  // Clear the flash a moment after it starts.
  useEffect(() => {
    if (!flashPath) return;
    const t = setTimeout(() => setFlashPath(null), 1100);
    return () => clearTimeout(t);
  }, [flashPath]);

  function toggleDir(path: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function expandDir(path: string): void {
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }

  function beginRename(node: VaultNode): void {
    setRenaming(node.path);
    setDraft(node.kind === "file" ? noteName(node.name) : node.name);
  }

  async function commitRename(node: VaultNode): Promise<void> {
    const value = draft.trim();
    setRenaming(null);
    if (!value) return;
    const ext = node.kind === "file" ? ".md" : "";
    const stem = node.kind === "file" ? value.replace(/\.md$/i, "") : value;
    const dir = dirName(node.path);
    const nextPath = `${dir ? dir + "/" : ""}${stem}${ext}`;
    if (nextPath === node.path) return;
    await props.onRename(node.path, nextPath);
  }

  async function createNoteIn(dir: string): Promise<void> {
    if (dir) expandDir(dir);
    const created = await props.onCreateNote(dir);
    // Drop straight into rename so the user names it.
    setRenaming(created);
    setDraft(noteName(created));
  }

  async function createFolderIn(dir: string): Promise<void> {
    if (dir) expandDir(dir);
    const created = await props.onCreateFolder(dir);
    setRenaming(created);
    setDraft(baseName(created));
  }

  async function handleDelete(node: VaultNode): Promise<void> {
    const what = node.kind === "dir" ? `folder "${node.name}" and everything in it` : `"${node.name}"`;
    if (!window.confirm(`Delete ${what}? It will be moved to your system Trash.`)) return;
    await props.onDelete(node.path);
  }

  function privacyTarget(node: VaultNode): PrivacyTarget {
    return node.kind === "file" ? "file" : "folder";
  }

  async function setNodePrivacy(node: VaultNode, mode: PrivacyMode): Promise<void> {
    if (mode === "local-only") {
      const what = node.kind === "dir" ? `folder "${node.name}" and its notes` : `"${node.name}"`;
      if (
        !window.confirm(
          `Keep ${what} local only?\n\nExisting cloud copies will be removed for all synced devices and shared workspace members. The local files stay on this device.`,
        )
      ) {
        return;
      }
    }
    await props.onSetPrivacy(node.path, privacyTarget(node), mode);
  }

  async function clearNodePrivacy(node: VaultNode): Promise<void> {
    await props.onClearPrivacy(node.path, privacyTarget(node));
  }

  // Delete a batch of notes behind a single confirmation.
  async function handleDeleteMany(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (paths.length === 1) {
      const only = paths[0]!;
      const node = visibleRows.find((n) => n.path === only);
      if (node) return handleDelete(node);
      // Not currently visible (e.g. inside a collapsed folder) — delete the one
      // path directly rather than falling into the plural "Delete 1 notes" dialog.
      if (!window.confirm("Delete this note? It will be moved to your system Trash.")) return;
      await props.onDelete(only);
      setMultiSel(new Set());
      return;
    }
    if (!window.confirm(`Delete ${paths.length} notes? They will be moved to your system Trash.`)) return;
    for (const p of paths) await props.onDelete(p);
    setMultiSel(new Set());
  }

  // Click on a note row: plain click opens (and clears any multi-selection),
  // Cmd/Ctrl+click toggles one note, Shift+click selects a range.
  function onFileClick(e: React.MouseEvent, node: VaultNode): void {
    const path = node.path;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      // A modifier-click builds a selection without opening the note, so it
      // won't move focus on its own — focus the row explicitly so the tree's
      // Delete/Backspace handler receives keystrokes.
      (e.currentTarget as HTMLElement).focus();
    }
    if (e.metaKey || e.ctrlKey) {
      e.stopPropagation();
      setMultiSel((prev) => {
        const next = new Set(prev);
        // Seed with the currently open note so Cmd+click extends from it.
        if (next.size === 0 && selectedPath && selectedPath !== path) next.add(selectedPath);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      anchorRef.current = path;
      return;
    }
    if (e.shiftKey) {
      e.stopPropagation();
      setMultiSel(new Set(fileRangeBetween(anchorRef.current ?? selectedPath, path)));
      return;
    }
    setMultiSel(new Set());
    anchorRef.current = path;
    onSelect(path);
  }

  // The notes a Delete/Backspace keypress would remove: the multi-selection if
  // any, otherwise the single open note.
  function effectiveSelection(): string[] {
    if (multiSel.size > 0) return [...multiSel];
    if (selectedPath && selectedPath.endsWith(".md")) return [selectedPath];
    return [];
  }

  // Close the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // The menu's height depends on the selected item, so measure it after render
  // and move it away from any viewport edge before the browser paints it.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const rect = element.getBoundingClientRect();
    const fitted = fitMenuToViewport(
      menu,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (fitted.x === menu.x && fitted.y === menu.y) return;
    setMenu((current) => (current ? { ...current, ...fitted } : null));
  }, [menu]);

  function openMenu(e: React.MouseEvent, node: VaultNode | null): void {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking a note outside the current multi-selection collapses it,
    // so the menu acts on the clicked row rather than a stale selection.
    if (!node || node.kind !== "file" || !multiSel.has(node.path)) setMultiSel(new Set());
    setMenu({ x: e.clientX, y: e.clientY, node });
  }

  // Delete/Backspace removes the effective selection (multi-selection, or the
  // open note). Ignored while renaming so it edits the input text instead.
  function onTreeKeyDown(e: React.KeyboardEvent): void {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (renaming) return;
    const paths = effectiveSelection();
    if (paths.length === 0) return;
    e.preventDefault();
    void handleDeleteMany(paths);
  }

  // ---- Drag and drop ------------------------------------------------------

  function startDrag(e: React.DragEvent, node: VaultNode): void {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MOVE_MIME, node.path);
    // Carry a lifted, rotated chip (styled in styles.css) instead of the
    // browser's default row snapshot, so the drag reads as "picked up".
    const ghost = document.createElement("div");
    ghost.className = "tree-drag-ghost";
    ghost.textContent = node.kind === "file" ? noteName(node.name) : node.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 16);
    dragGhostRef.current = ghost;
    setDragging(node);
  }

  function endDrag(): void {
    removeDragGhost();
    setDragging(null);
    setDrop(null);
  }

  // Work out where a drop on `node` would land, given the cursor's vertical
  // position within the row. Returns null when the drop isn't allowed.
  function intentFor(e: React.DragEvent, node: VaultNode): DropIntent | null {
    const drag = dragging;
    if (!drag) return null;
    const inSubtree = node.path === drag.path || node.path.startsWith(drag.path + "/");
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 1;
    const sibling = (side: "before" | "after"): DropIntent | null => {
      if (node.path === drag.path) return null; // dropping next to itself is a no-op
      const dir = dirName(node.path);
      // Folders only reorder within their own parent — moving a folder across
      // parents would strand the paths of any of its notes open in tabs.
      if (drag.kind === "dir" && dir !== dirName(drag.path)) return null;
      if (inSubtree) return null; // can't drop a folder beside something inside it
      return { ref: node.path, dir, mode: side };
    };
    if (node.kind === "dir") {
      if (y < h * 0.3) return sibling("before");
      if (y > h * 0.7) return sibling("after");
      // Middle band → drop inside the folder (files only).
      if (drag.kind === "dir" || inSubtree) return null;
      return { ref: node.path, dir: node.path, mode: "into" };
    }
    return sibling(y < h / 2 ? "before" : "after");
  }

  function onRowDragOver(e: React.DragEvent, node: VaultNode): void {
    if (!e.dataTransfer.types.includes(MOVE_MIME)) return;
    e.stopPropagation();
    const intent = intentFor(e, node);
    if (!intent) {
      setDrop(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop(intent);
  }

  async function performDrop(intent: DropIntent | null): Promise<void> {
    const drag = dragging;
    endDrag();
    if (!drag || !intent) return;
    const movedPath = drag.path;
    const sourceDir = dirName(movedPath);
    const targetDir = intent.dir;
    const sibs = (childrenByDir.get(targetDir) ?? []).map((n) => baseName(n.path));
    const refBase = intent.mode === "into" ? null : baseName(intent.ref);
    const side = intent.mode === "after" ? "after" : "before";
    // A deliberate drag defines a manual position, so switch the tree to the
    // matching sort mode and make the result immediately visible.
    setSortMode("custom");
    if (sourceDir === targetDir) {
      // Pure reorder — nothing touches the filesystem.
      place(targetDir, sibs, baseName(movedPath), refBase, side);
    } else {
      const actual = await props.onMove(movedPath, targetDir);
      place(targetDir, sibs, baseName(actual), refBase, side, {
        dir: sourceDir,
        name: baseName(movedPath),
      });
    }
  }

  function onRowDrop(e: React.DragEvent, node: VaultNode): void {
    if (!e.dataTransfer.types.includes(MOVE_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    void performDrop(intentFor(e, node) ?? drop);
  }

  // ---- Rendering ----------------------------------------------------------

  const rootDrop = drop?.mode === "into" && drop.ref === "" && drop.dir === "";

  function dropClasses(path: string): string {
    if (!drop || drop.ref !== path) return "";
    if (drop.mode === "into") return " is-drop";
    return drop.mode === "before" ? " is-insert-before" : " is-insert-after";
  }

  function renderNode(node: VaultNode, depth: number): React.ReactNode {
    const indent = 8 + depth * 14;
    const rowStyle = { paddingLeft: `${indent}px`, "--indent": `${indent}px` } as React.CSSProperties;
    const isRenaming = renaming === node.path;
    const isDragging = dragging?.path === node.path;
    const flashCls = flashPath === node.path ? " is-flash" : "";

    const nameEl = isRenaming ? (
      <input
        className="rename-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => void commitRename(node)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitRename(node);
          if (e.key === "Escape") setRenaming(null);
        }}
      />
    ) : (
      <span className="tree-label">{node.kind === "file" ? noteName(node.name) : node.name}</span>
    );

    if (node.kind === "dir") {
      const isCollapsed = collapsed.has(node.path);
      return (
        <li key={node.path}>
          <div
            className={`tree-row tree-dir${isDragging ? " is-dragging" : ""}${dropClasses(node.path)}${flashCls}`}
            style={rowStyle}
            data-path={node.path}
            draggable
            onDragStart={(e) => startDrag(e, node)}
            onDragEnd={endDrag}
            onDragOver={(e) => onRowDragOver(e, node)}
            onDrop={(e) => onRowDrop(e, node)}
            onClick={() => toggleDir(node.path)}
            onContextMenu={(e) => openMenu(e, node)}
          >
            <span className={`tree-chevron${isCollapsed ? "" : " is-open"}`}>
              <ChevronIcon />
            </span>
            <span className="tree-label">{nameEl}</span>
            {node.privacy.mode !== "public" ? <PrivacyTreeIcon privacy={node.privacy} /> : null}
          </div>
          {!isCollapsed && node.children.length > 0 ? (
            <ul className="tree-children">{node.children.map((c) => renderNode(c, depth + 1))}</ul>
          ) : null}
        </li>
      );
    }

    const isSelected = isRowSelected(node.path);
    // Round only the outer corners of a contiguous run of selected notes so a
    // multi-selection reads as one block instead of a stack of scalloped pills.
    const i = rowIndex.get(node.path) ?? -1;
    const prev = i > 0 ? visibleRows[i - 1] : null;
    const next = i >= 0 && i < visibleRows.length - 1 ? visibleRows[i + 1] : null;
    const selTop = isSelected && !(prev?.kind === "file" && isRowSelected(prev.path));
    const selBottom = isSelected && !(next?.kind === "file" && isRowSelected(next.path));
    const selCls = isSelected
      ? ` is-selected${selTop ? " is-sel-top" : ""}${selBottom ? " is-sel-bottom" : ""}`
      : "";
    return (
      <li key={node.path}>
        <div
          className={`tree-row tree-file${selCls}${
            isDragging ? " is-dragging" : ""
          }${dropClasses(node.path)}${flashCls}`}
          style={rowStyle}
          data-path={node.path}
          draggable
          onDragStart={(e) => startDrag(e, node)}
          onDragEnd={endDrag}
          onDragOver={(e) => onRowDragOver(e, node)}
          onDrop={(e) => onRowDrop(e, node)}
          onClick={(e) => onFileClick(e, node)}
          onContextMenu={(e) => openMenu(e, node)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(node.path);
          }}
        >
          <span className="tree-spacer" />
          {nameEl}
          {node.privacy.mode !== "public" ? <PrivacyTreeIcon privacy={node.privacy} /> : null}
        </div>
      </li>
    );
  }

  return (
    <nav className="pane pane-left">
      {/* Explorer toolbar (Obsidian-style): always-visible actions pinned above
          the sections. The sort menu drops down from its button. */}
      <header className="explorer-toolbar" aria-label="File actions">
        <button className="icon-btn explorer-tool" title="New note" onClick={() => void createNoteIn("")}>
          <NotePlusIcon />
        </button>
        <button className="icon-btn explorer-tool" title="New folder" onClick={() => void createFolderIn("")}>
          <FolderPlusIcon />
        </button>
        <div className="explorer-sort" ref={sortRef}>
          <button
            className={`icon-btn explorer-tool${sortOpen ? " is-active" : ""}`}
            title="Change sort order"
            aria-label="Change sort order"
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((open) => !open)}
          >
            <ArrowDownAZ size={16} strokeWidth={1.7} aria-hidden />
          </button>
          {sortOpen ? (
            <div className="explorer-sort-menu" role="menu" aria-label="Sort files">
              <div className="explorer-sort-label">Sort order</div>
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.mode}
                  className="explorer-sort-option"
                  role="menuitemradio"
                  aria-checked={sortMode === option.mode}
                  onClick={() => {
                    setSortMode(option.mode);
                    setSortOpen(false);
                  }}
                >
                  <span className="explorer-sort-check">
                    {sortMode === option.mode ? (
                      <Check size={14} strokeWidth={1.9} aria-hidden />
                    ) : null}
                  </span>
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          className="icon-btn explorer-tool"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          disabled={folderPaths.length === 0}
          onClick={() => setCollapsed(new Set(folderPaths))}
        >
          <ChevronsDownUp size={16} strokeWidth={1.7} aria-hidden />
        </button>
      </header>
      <div
        ref={scrollRef}
        className={`tree-scroll side-scroll${rootDrop ? " is-drop-root" : ""}`}
        onKeyDown={onTreeKeyDown}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => {
          // Only fires over empty space — row handlers stop propagation. Drops
          // here move/reorder to the end of the vault root.
          if (!e.dataTransfer.types.includes(MOVE_MIME) || !dragging) return;
          // A folder can only reorder within its parent, so don't accept one
          // here unless it already lives at the root.
          if (dragging.kind === "dir" && dirName(dragging.path) !== "") return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDrop({ ref: "", dir: "", mode: "into" });
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(MOVE_MIME)) return;
          e.preventDefault();
          void performDrop({ ref: "", dir: "", mode: "into" });
        }}
        onDragLeave={(e) => {
          // Clear only when the cursor actually leaves the tree pane.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
        }}
      >
        {props.recentPaths.length > 0 ? (
          <Section
            label="Recents"
            collapsed={closedSections.has("recents")}
            onToggle={() => toggleSection("recents")}
          >
            <ul className="side-list">
              {props.recentPaths.map((p) => (
                <li key={p}>
                  <button
                    className={`side-row${p === selectedPath ? " is-active" : ""}`}
                    title={p}
                    onClick={() => onSelect(p)}
                  >
                    <FileText size={15} strokeWidth={1.6} aria-hidden />
                    <span className="side-row-label">{noteName(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section
          label="Shared"
          collapsed={closedSections.has("shared")}
          onToggle={() => toggleSection("shared")}
        >
          <button
            className={`side-row${props.sharedWorkspaceName ? "" : " side-row-ghost"}`}
            onClick={props.onStartCollaborating}
          >
            {props.sharedWorkspaceName ? (
              <Users size={15} strokeWidth={1.6} aria-hidden />
            ) : (
              <Plus size={15} strokeWidth={1.6} aria-hidden />
            )}
            <span className="side-row-label">
              {props.sharedWorkspaceName ?? "Start collaborating"}
            </span>
          </button>
        </Section>

        <Section
          label="Private"
          collapsed={closedSections.has("private")}
          onToggle={() => toggleSection("private")}
        >
          <ul className="tree-root">{orderedTree.map((n) => renderNode(n, 0))}</ul>
          {orderedTree.length === 0 ? (
            <button className="side-row side-row-ghost" onClick={() => void createNoteIn("")}>
              <Plus size={15} strokeWidth={1.6} aria-hidden />
              <span className="side-row-label">Add a note</span>
            </button>
          ) : null}
        </Section>
      </div>

      <div className="side-bottom">
        {bottomPanel === "trash" ? (
          <div className="side-pop" role="dialog" aria-label="Trash">
            <div className="side-pop-title">Trash</div>
            <div className="side-pop-empty">
              <Trash2 size={20} strokeWidth={1.5} aria-hidden />
              <span>Trash is empty</span>
              <p>
                Deleted notes are removed permanently for now — a recoverable Trash is on the
                roadmap.
              </p>
            </div>
          </div>
        ) : null}
        {bottomPanel === "help" ? (
          <div className="side-pop" role="menu" aria-label="Help">
            <button
              className="side-pop-item"
              role="menuitem"
              onClick={() => {
                setBottomPanel(null);
                props.onOpenCommandPalette();
              }}
            >
              <span>Keyboard shortcuts &amp; commands</span>
              <kbd>⌘P</kbd>
            </button>
            <a
              className="side-pop-item"
              role="menuitem"
              href="https://github.com/RyanTL/kestravault#readme"
              target="_blank"
              rel="noreferrer"
              onClick={() => setBottomPanel(null)}
            >
              <span>Documentation</span>
            </a>
            <a
              className="side-pop-item"
              role="menuitem"
              href="https://github.com/RyanTL/kestravault/issues"
              target="_blank"
              rel="noreferrer"
              onClick={() => setBottomPanel(null)}
            >
              <span>Report an issue</span>
            </a>
          </div>
        ) : null}

        <button
          className={`side-row${props.tasksOpen ? " is-active" : ""}`}
          onClick={props.onOpenTasks}
        >
          <SquareCheckBig size={15} strokeWidth={1.6} aria-hidden />
          <span className="side-row-label">My Tasks</span>
        </button>
        <button
          className={`side-row${bottomPanel === "trash" ? " is-active" : ""}`}
          aria-expanded={bottomPanel === "trash"}
          onClick={() => setBottomPanel((p) => (p === "trash" ? null : "trash"))}
        >
          <Trash2 size={15} strokeWidth={1.6} aria-hidden />
          <span className="side-row-label">Trash</span>
        </button>
        <button
          className={`side-row${bottomPanel === "help" ? " is-active" : ""}`}
          aria-expanded={bottomPanel === "help"}
          onClick={() => setBottomPanel((p) => (p === "help" ? null : "help"))}
        >
          <CircleHelp size={15} strokeWidth={1.6} aria-hidden />
          <span className="side-row-label">Help</span>
        </button>
      </div>

      <footer className="vault-footer">
        <VaultSwitcher
          vaults={props.vaults}
          fallbackName={vaultName}
          onSwitch={props.onSwitchVault}
          onOpenFolder={props.onOpenVaultFolder}
          onCreate={props.onCreateVault}
          onRemove={props.onRemoveVault}
          sharedWorkspaceName={props.sharedWorkspaceName}
          onManageSharing={props.onStartCollaborating}
        />
      </footer>

      {menu ? (
        <ul ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.node?.kind === "dir" || menu.node === null ? (
            <>
              <li onClick={() => void createNoteIn(menu.node?.path ?? "")}>New note</li>
              <li onClick={() => void createFolderIn(menu.node?.path ?? "")}>New folder</li>
            </>
          ) : null}
          {menu.node ? (
            <>
              {menu.node.kind === "file" ? (
                <li onClick={() => props.onToggleBookmark(menu.node!.path)}>
                  {props.isBookmarked(menu.node.path) ? "Remove bookmark" : "Bookmark"}
                </li>
              ) : null}
              <li onClick={() => void setNodePrivacy(menu.node!, "public")}>
                Visible to cloud AI
              </li>
              <li onClick={() => void setNodePrivacy(menu.node!, "cloud-ai-private")}>
                Sync to cloud, hide from AI
              </li>
              <li onClick={() => void setNodePrivacy(menu.node!, "local-only")}>Keep local only</li>
              {menu.node.privacy.explicit ? (
                <li onClick={() => void clearNodePrivacy(menu.node!)}>Use inherited setting</li>
              ) : null}
              <li onClick={() => beginRename(menu.node!)}>Rename</li>
              {menu.node.kind === "file" && multiSel.has(menu.node.path) && multiSel.size > 1 ? (
                <li className="danger" onClick={() => void handleDeleteMany([...multiSel])}>
                  Delete {multiSel.size} notes
                </li>
              ) : (
                <li className="danger" onClick={() => void handleDelete(menu.node!)}>
                  Delete
                </li>
              )}
              <li onClick={() => onReveal(menu.node!.path)}>Reveal in Finder</li>
            </>
          ) : (
            <li onClick={() => onReveal()}>Reveal vault in Finder</li>
          )}
        </ul>
      ) : null}
    </nav>
  );
}
