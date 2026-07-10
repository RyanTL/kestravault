// Typed request/response + internal contract for the `ingest` edge function.
//
// These mirror the relevant types in packages/core/src/types (Zone, FileType,
// FileOp, RunMode, IngestMode, …). They are re-declared here rather than
// imported because edge functions run on Deno and do not share the Node/TS
// build graph of packages/*. Keep them in sync by hand; the shapes are small.

// ---------------------------------------------------------------------------
// Mirrors of packages/core enums (see plan/data-model.md & agent-loop.md).
// ---------------------------------------------------------------------------

export type Zone = "sources" | "wiki" | "notes";

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

export type FileOp = "create" | "update" | "delete";

/** Per-run model tier: light = Haiku, default = Sonnet, deep = Opus. */
export type RunMode = "light" | "default" | "deep";

/** Background (Batch-eligible) vs live (user watching) ingestion. */
export type IngestMode = "async" | "realtime";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Body of `POST /functions/v1/ingest`.
 *
 * The orchestrator has already saved the raw paste to `sources/s-<date>-<slug>.md`
 * (status `pending`) — step 1 of the ingest loop — so the function receives a
 * *reference* to that source, not its bytes.
 */
export interface IngestRequest {
  /** Workspace ("brain") the source belongs to. */
  workspaceId: string;
  /** Id of the already-saved row in `public.files` (zone = 'sources'). */
  sourceId: string;
  /** Model tier for this run. Defaults to "default" (Sonnet). */
  mode?: RunMode;
  /** "realtime" streams progress when the user is watching; else "async". */
  ingestMode?: IngestMode;
  /**
   * Idempotency key = source id + content hash (plan/agent-loop.md "Edge
   * cases"). A duplicate drop with the same key is a no-op. Falls back to the
   * `x-idempotency-key` header, then to `sourceId`.
   */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type IngestStatus = "ingested" | "skipped" | "failed";

/** One file the change-set touched, summarised for the change feed. */
export interface TouchedFile {
  fileId: string;
  path: string;
  zone: Zone;
  op: FileOp;
  beforeVersion: number | null;
  afterVersion: number | null;
}

export interface IngestResponse {
  status: IngestStatus;
  /** The atomic change-set this ingest produced (null when skipped/failed). */
  changeSetId: string | null;
  /** Files created/updated by the run — backs "touched N pages" + diffs + undo. */
  touched: TouchedFile[];
  /** Human-readable summary, e.g. "Ingested 'Intro to Rust ownership'". */
  summary: string;
  /** The single line appended to log.md for this operation. */
  logLine: string;
  /** Present when status = "failed". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal contract with the Managed Agent (the stubbed boundary)
// ---------------------------------------------------------------------------

/** A file mounted into the agent session, with the permission it is mounted at. */
export interface MountedFile {
  fileId: string;
  path: string;
  zone: Zone;
  type: FileType;
  content: string;
  sha256: string;
  version: number;
  mount: "ro" | "rw";
}

/** A file edit the agent proposes, read back from the session on idle. */
export interface ProposedEdit {
  path: string;
  zone: Zone;
  type: FileType;
  op: FileOp;
  /** Full new content (null on delete). */
  content: string | null;
}

/** What `runMaintainerAgent` returns once the session goes idle. */
export interface AgentRunResult {
  edits: ProposedEdit[];
  /** Short natural-language summary the agent ends its run with. */
  summary: string;
}
