import type { FileType, Zone } from "../types/enums.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/**
 * Derive the canonical-store metadata (zone / type / title) for a local
 * markdown file from its path and content. The local mirror is plain files —
 * these columns exist only server-side, so the sync engine reconstructs them
 * on every push. Total: malformed frontmatter degrades to defaults, never throws.
 */

export interface DerivedFileMeta {
  zone: Zone;
  type: FileType;
  title: string;
}

const ZONES: readonly Zone[] = ["sources", "wiki", "notes"];

// Runtime mirror of the FileType union (../types/enums.ts) for validating a
// frontmatter `type:` value.
const FILE_TYPES: readonly FileType[] = [
  "source",
  "entity",
  "concept",
  "topic",
  "overview",
  "comparison",
  "source-summary",
  "note",
  "index",
  "log",
  "instructions",
];

/** Zone from the path's top folder; anything outside the three zones is
 *  human-owned by definition, so it maps to `notes` (plan/data-model.md). */
export function deriveZone(path: string): Zone {
  const top = path.split("/")[0] as Zone;
  return ZONES.includes(top) ? top : "notes";
}

function defaultType(zone: Zone): FileType {
  switch (zone) {
    case "sources":
      return "source";
    case "wiki":
      return "concept";
    case "notes":
      return "note";
  }
}

function filenameStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

export function deriveFileMeta(path: string, content: string): DerivedFileMeta {
  const zone = deriveZone(path);
  let data: Record<string, unknown> = {};
  try {
    data = parseFrontmatter(content).data;
  } catch {
    // Malformed YAML — treat as no frontmatter.
  }
  const type = FILE_TYPES.includes(data.type as FileType)
    ? (data.type as FileType)
    : defaultType(zone);
  const title =
    typeof data.title === "string" && data.title.trim() !== ""
      ? data.title.trim()
      : filenameStem(path);
  return { zone, type, title };
}
