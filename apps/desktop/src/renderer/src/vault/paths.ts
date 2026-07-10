import type { VaultNode } from "@renderer/vault/types";

// Small helpers for working with vault-relative POSIX paths in the renderer.

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** File name without its `.md` extension — the display title / link target. */
export function noteName(path: string): string {
  return baseName(path).replace(/\.md$/i, "");
}

export type VaultFile = Pick<Extract<VaultNode, { kind: "file" }>, "name" | "path"> &
  Partial<Pick<Extract<VaultNode, { kind: "file" }>, "privacy" | "private">>;

/** Depth-first list of every file node in the tree. */
export function flattenFiles(nodes: VaultNode[]): VaultFile[] {
  const out: VaultFile[] = [];
  const walk = (ns: VaultNode[]): void => {
    for (const n of ns) {
      if (n.kind === "file") {
        out.push({ name: n.name, path: n.path, privacy: n.privacy, private: n.private });
      }
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Resolve a `[[wikilink]]` target to a vault path. Matches an exact relative
 * path first, then a unique note name (case-insensitive), the way Obsidian does.
 * Returns null when no note matches (the caller can offer to create it).
 */
export function resolveWikiLink(
  target: string,
  files: { name: string; path: string }[],
): string | null {
  const want = target.replace(/\.md$/i, "").toLowerCase();
  // Exact path (with or without folders).
  const exact = files.find((f) => f.path.replace(/\.md$/i, "").toLowerCase() === want);
  if (exact) return exact.path;
  // Bare note name.
  const byName = files.find((f) => noteName(f.path).toLowerCase() === want);
  return byName ? byName.path : null;
}
