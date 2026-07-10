import type { IsoDate, Ulid } from "./ids.js";
import type { FileType, SourceOrigin, SourceStatus, Zone } from "./enums.js";

/**
 * YAML frontmatter shapes (see plan/data-model.md). These describe what lives
 * at the top of the markdown files themselves — distinct from the canonical
 * row shapes in entities.ts.
 */

export interface BaseFrontmatter {
  id: Ulid;
  title: string;
  type: FileType;
  zone: Zone;
  tags: string[];
}

export interface SourceFrontmatter extends BaseFrontmatter {
  type: "source";
  zone: "sources";
  added: IsoDate;
  origin: SourceOrigin;
  url: string | null;
  status: SourceStatus;
}

export interface WikiFrontmatter extends BaseFrontmatter {
  zone: "wiki";
  created: IsoDate;
  updated: IsoDate;
  /** Source ids this page draws on (provenance). */
  sources: Ulid[];
  status: "active" | "archived";
}

export interface NoteFrontmatter extends BaseFrontmatter {
  type: "note";
  zone: "notes";
  created: IsoDate;
  updated: IsoDate;
  /** Human-owned; the agent reads but won't edit unless explicitly asked. */
  aiManaged: boolean;
}
