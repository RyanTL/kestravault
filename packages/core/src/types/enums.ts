/** The three ownership zones of a workspace (see plan/data-model.md). */
export type Zone = "sources" | "wiki" | "notes";

/** The `type` field carried in a file's frontmatter. */
export type FileType =
  | "source"
  | "entity"
  | "concept"
  | "topic"
  | "overview"
  | "comparison"
  | "source-summary"
  | "note"
  | "index"
  | "log"
  | "instructions";

/** Who authored a given file version. */
export type UpdatedBy = "human" | "agent";

/** What kind of operation produced a change-set. */
export type ChangeSetKind = "ingest" | "query_fileback" | "lint" | "manual";

/** The per-file operation recorded inside a change-set. */
export type FileOp = "create" | "update" | "delete";

/** How a source entered the workspace (v1 capture is paste-only). */
export type SourceOrigin = "paste" | "upload" | "url";

/** Lifecycle of a raw source as the agent processes it. */
export type SourceStatus = "pending" | "ingested" | "failed";

/** Whether ingestion runs in the background (Batch) or live (user watching). */
export type IngestMode = "async" | "realtime";

/** Per-run model tier (maps to Haiku / Sonnet / Opus — see plan/agent-loop.md). */
export type RunMode = "light" | "default" | "deep";
