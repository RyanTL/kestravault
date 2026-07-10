import type { ChangeSet } from "../types/entities.js";
import type { IsoTimestamp, Ulid } from "../types/ids.js";
import type { RunMode } from "../types/enums.js";
import { ulid } from "../utils/ulid.js";

/**
 * The ingest boundary `apps/desktop` (and the orchestrator) will consume. A real
 * ingest spins up an Anthropic Managed-Agents session, lets it edit the wiki, then
 * diffs the result back into an atomic change-set (see plan/agent-loop.md). That
 * call lands later; THIS is a typed STUB that returns a deterministic fake
 * change-set so downstream code can be built and tested against the shape now.
 */

export interface IngestSourceInput {
  /** Workspace the source was dropped into. */
  workspaceId: Ulid;
  /** Where the orchestrator saved the raw source, e.g. `sources/s-<date>-<slug>.md`. */
  sourcePath: string;
  /** Raw markdown content of the dropped source. */
  content: string;
  /** Per-run model tier; defaults to the workspace's configured mode downstream. */
  mode?: RunMode;
}

/** Injectable id/clock so the stub (and the real impl) stay testable. */
export interface IngestDeps {
  newId?: () => Ulid;
  now?: () => IsoTimestamp;
}

/** Marker on the stub's `sourceEvent` so callers can detect the placeholder. */
export const INGEST_STUB_MARKER = "stub:not-implemented" as const;

/**
 * Ingest a raw source into the workspace wiki, returning the resulting change-set.
 *
 * STUB: does not call Managed Agents and writes nothing. It returns a
 * deterministic, well-formed {@link ChangeSet} (kind `ingest`, no file changes,
 * not reverted) whose `sourceEvent` echoes the input and carries
 * {@link INGEST_STUB_MARKER}. Swap the body for the real agent loop later without
 * changing this signature.
 */
export function ingestSource(
  input: IngestSourceInput,
  deps: IngestDeps = {},
): Promise<ChangeSet> {
  const newId = deps.newId ?? (() => ulid());
  const now = deps.now ?? (() => new Date().toISOString());

  const changeSet: ChangeSet = {
    id: newId(),
    workspaceId: input.workspaceId,
    kind: "ingest",
    summary: `Ingest (stub) for ${input.sourcePath} — not implemented`,
    sourceEvent: {
      marker: INGEST_STUB_MARKER,
      sourcePath: input.sourcePath,
      contentLength: input.content.length,
      mode: input.mode ?? null,
    },
    authorId: null,
    createdAt: now(),
    reverted: false,
  };

  return Promise.resolve(changeSet);
}
