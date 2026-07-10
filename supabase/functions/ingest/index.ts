// KestraVault — `ingest` edge function (skeleton).
//
// Implements the ingest loop from plan/agent-loop.md as a typed scaffold:
//
//   source in  ->  wiki page(s) + index/cross-refs + log entry out
//
//   1. validate request, load the saved source (orchestrator already wrote it
//      to sources/ with status `pending`)
//   2. idempotency check (source id + content hash)
//   3. mount workspace files for the agent (sources RO, wiki RW, index/log RW,
//      instructions RO) and snapshot their hashes
//   4. >>> runMaintainerAgent(): the Managed Agents call — STUBBED <<<
//        read source -> grep/read wiki -> create/extend pages -> [[xrefs]] ->
//        update index.md -> append one line to log.md
//   5. diff the agent's edits vs the snapshot -> build ONE atomic change-set ->
//      apply to canonical (new versions, updated_by=agent), mark source ingested
//   6. (Realtime push happens automatically: the init migration publishes
//      `files` + `change_sets` inserts to supabase_realtime.)
//
// The Managed Agents integration (step 4) is the only stub. The surrounding
// contract — request/response shapes, idempotency, mounting, change-set build &
// apply — is laid out so the integrator can drop the agent call in.
//
// NOTE: not deployed/applied against a live project at authoring time. Runs on
// Deno (Supabase Edge Runtime); imports are URL/JSR-based (no npm deps added).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { authorizeIngest, IngestAuthError } from "./auth.ts";
import type {
  AgentRunResult,
  IngestRequest,
  IngestResponse,
  MountedFile,
  ProposedEdit,
  RunMode,
  TouchedFile,
} from "./types.ts";

// Minimal shape of a `public.files` row we read/write here.
interface FileRow {
  id: string;
  workspace_id: string;
  path: string;
  zone: MountedFile["zone"];
  type: MountedFile["type"];
  title: string;
  content: string;
  sha256: string;
  version: number;
  updated_by: "human" | "agent";
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let request: IngestRequest;
  try {
    request = parseRequest(await req.json(), req.headers.get("x-idempotency-key"));
  } catch (err) {
    return jsonResponse({ error: `bad request: ${messageOf(err)}` }, 400);
  }

  const supabase = serviceClient();

  // Authorize BEFORE any service-role work. ingest bypasses RLS, so this is the
  // access boundary: a trusted orchestrator (shared secret) or a workspace
  // member (user JWT). Everything else is refused — see auth.ts.
  try {
    await authorizeIngest(req.headers, request.workspaceId, {
      ingestSecret: Deno.env.get("INGEST_SECRET"),
      getUserId: async (token) => {
        const { data, error } = await supabase.auth.getUser(token);
        return error || !data.user ? null : data.user.id;
      },
      isMember: async (workspaceId, userId) => {
        const { data, error } = await supabase
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) throw new Error(`membership check failed: ${error.message}`);
        return data !== null;
      },
    });
  } catch (err) {
    if (err instanceof IngestAuthError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    throw err; // unexpected (e.g. DB error during the membership lookup) → 500
  }

  try {
    const result = await ingest(supabase, request);
    return jsonResponse(result, result.status === "failed" ? 500 : 200);
  } catch (err) {
    // Step 5 invariant: on any error the change-set is discarded (partials are
    // never applied). Here that means we simply never reached the apply step.
    const failure: IngestResponse = {
      status: "failed",
      changeSetId: null,
      touched: [],
      summary: "",
      logLine: "",
      error: messageOf(err),
    };
    return jsonResponse(failure, 500);
  }
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function ingest(supabase: SupabaseClient, request: IngestRequest): Promise<IngestResponse> {
  const mode: RunMode = request.mode ?? "default";

  // (1) Load the source the orchestrator already saved (zone = 'sources').
  const source = await loadSource(supabase, request.workspaceId, request.sourceId);
  const idempotencyKey = request.idempotencyKey ?? `${source.id}:${source.sha256}`;

  // (2) Idempotency: a duplicate drop (same source id + content hash) is a no-op.
  if (await alreadyIngested(supabase, request.workspaceId, idempotencyKey)) {
    return {
      status: "skipped",
      changeSetId: null,
      touched: [],
      summary: `Already ingested '${source.title}'`,
      logLine: "",
    };
  }

  // (3) Mount the workspace for the agent and snapshot hashes for the diff-back.
  const mounts = await buildMounts(supabase, request.workspaceId, source);
  const snapshot = new Map(mounts.map((m) => [m.path, m.sha256]));

  // (4) Run the maintainer agent. THIS IS THE STUB.
  const run = await runMaintainerAgent({ mode, source, mounts });

  // (5) Diff vs snapshot -> one atomic change-set -> apply to canonical.
  const hashes = await Promise.all(run.edits.map((e) => sha256Of(e.content)));
  const edits = run.edits.filter((e, i) => snapshot.get(e.path) !== hashes[i]);
  if (edits.length === 0) {
    return {
      status: "skipped",
      changeSetId: null,
      touched: [],
      summary: `No changes for '${source.title}'`,
      logLine: "",
    };
  }

  const summary = run.summary || `Ingested '${source.title}' — touched ${edits.length} page(s)`;
  const logLine = `## [${today()}] ingest | ${source.title}`;

  const { changeSetId, touched } = await applyChangeSet(supabase, {
    workspaceId: request.workspaceId,
    sourceId: source.id,
    idempotencyKey,
    summary,
    logLine,
    edits,
    mounts,
  });

  // (6) Realtime push is automatic (publication on `files` + `change_sets`).
  return { status: "ingested", changeSetId, touched, summary, logLine };
}

// ---------------------------------------------------------------------------
// (4) Managed Agents — STUB. Replace the body with the real session.
// ---------------------------------------------------------------------------

interface MaintainerArgs {
  mode: RunMode;
  source: FileRow;
  mounts: MountedFile[];
}

/**
 * Run the persisted "maintainer" Agent over the mounted workspace and return the
 * file edits it proposes.
 *
 * TODO(integrator): implement against Anthropic Managed Agents (plan/agent-loop.md
 * "Managed Agents setup"):
 *   1. Create a Session for the persisted maintainer Agent (referenced by id;
 *      never re-created per run). Model tier comes from `args.mode`
 *      (light=Haiku / default=Sonnet / deep=Opus).
 *   2. Mount `args.mounts` as session resources at their stated permission
 *      (sources RO, wiki RW, index/log RW, instructions RO). The read-only
 *      mounts are the primary enforcement of the zone matrix; the DB triggers in
 *      20260629000000_zone_enforcement.sql are defense in depth.
 *   3. Send the kickoff message (agent-loop.md "Kickoff instruction") with the
 *      per-workspace `.kestravault/instructions.md` schema injected.
 *   4. Stream events (-> live progress UI when ingestMode === "realtime").
 *   5. On idle, read back wiki/, index.md, log.md and return them as ProposedEdit[].
 *
 * Use `limited` networking (no egress for v1 paste capture). Batch-eligible when
 * async; stream when the user is watching.
 */
function runMaintainerAgent(_args: MaintainerArgs): Promise<AgentRunResult> {
  // Intentionally not implemented — this is the one stubbed boundary.
  throw new NotImplemented(
    "runMaintainerAgent: Managed Agents integration not yet implemented (see TODO).",
  );

  // Reference shape the real implementation must return:
  // return Promise.resolve({
  //   edits: [
  //     { path: "wiki/concepts/ownership.md", zone: "wiki", type: "concept",
  //       op: "update", content: "---\n...frontmatter...\n---\n# Ownership\n..." },
  //     { path: "index.md", zone: "wiki", type: "index", op: "update", content: "..." },
  //     { path: "log.md",   zone: "wiki", type: "log",   op: "update", content: "..." },
  //   ],
  //   summary: "Extended Ownership, linked Borrowing; updated index + log.",
  // });
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

async function loadSource(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceId: string,
): Promise<FileRow> {
  const { data, error } = await supabase
    .from("files")
    .select("*")
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId)
    .eq("zone", "sources")
    .single();

  if (error || !data) {
    throw new Error(`source ${sourceId} not found in workspace ${workspaceId}`);
  }
  return data as FileRow;
}

async function alreadyIngested(
  supabase: SupabaseClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("change_sets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "ingest")
    .eq("source_event->>idempotencyKey", idempotencyKey)
    .limit(1);

  if (error) throw new Error(`idempotency check failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Build the mount set per agent-loop.md step 2: the new source (RO), all wiki
 * pages (RW), index.md + log.md (RW), and instructions.md (RO).
 */
async function buildMounts(
  supabase: SupabaseClient,
  workspaceId: string,
  source: FileRow,
): Promise<MountedFile[]> {
  const { data, error } = await supabase
    .from("files")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("deleted", false);

  if (error) throw new Error(`failed to load workspace files: ${error.message}`);

  const rows = (data ?? []) as FileRow[];
  return rows
    .filter((r) => r.zone === "wiki" || r.id === source.id || r.type === "instructions")
    .map((r) => ({
      fileId: r.id,
      path: r.path,
      zone: r.zone,
      type: r.type,
      content: r.content,
      sha256: r.sha256,
      version: r.version,
      // sources/ + instructions.md are read-only; wiki/ + index/log are read/write.
      mount: r.zone === "sources" || r.type === "instructions" ? "ro" : "rw",
    }));
}

interface ApplyArgs {
  workspaceId: string;
  sourceId: string;
  idempotencyKey: string;
  summary: string;
  logLine: string;
  edits: ProposedEdit[];
  mounts: MountedFile[];
}

/**
 * Apply the agent's edits as ONE change-set (agent-loop.md step 5). Every file
 * write goes through the `commit_file_version` Postgres function — the same
 * atomic optimistic-concurrency path the sync engine uses — so each edit's
 * files-update + file_versions-append is transactional and a concurrent human
 * edit surfaces as a version_conflict (the whole ingest fails cleanly and the
 * idempotent retry re-runs against fresh state; partials from THIS run are
 * versioned rows, never silent overwrites).
 */
async function applyChangeSet(
  supabase: SupabaseClient,
  args: ApplyArgs,
): Promise<{ changeSetId: string; touched: TouchedFile[] }> {
  const changeSetId = ulid();
  const byPath = new Map(args.mounts.map((m) => [m.path, m]));

  const { error: csErr } = await supabase.from("change_sets").insert({
    id: changeSetId,
    workspace_id: args.workspaceId,
    kind: "ingest",
    summary: args.summary,
    source_event: { sourceId: args.sourceId, idempotencyKey: args.idempotencyKey },
    reverted: false,
  });
  if (csErr) throw new Error(`failed to create change_set: ${csErr.message}`);

  const touched: TouchedFile[] = [];

  for (const edit of args.edits) {
    const prior = byPath.get(edit.path);
    const beforeVersion = prior?.version ?? null;
    const afterVersion = (beforeVersion ?? 0) + 1;
    const fileId = prior?.fileId ?? ulid();
    const content = edit.op === "delete" ? (prior?.content ?? "") : (edit.content ?? "");

    // Atomic commit: version check + files update + file_versions append in
    // one transaction. expected_version = the mounted snapshot's version, so
    // a human (or another run) committing in between loses nobody's work.
    const { error: fErr } = await supabase.rpc("commit_file_version", {
      p_file_id: fileId,
      p_workspace_id: args.workspaceId,
      p_path: edit.path,
      p_zone: edit.zone,
      p_type: edit.type,
      p_title: titleFrom(edit, prior),
      p_content: content,
      p_sha256: await sha256Of(content),
      p_expected_version: beforeVersion ?? 0,
      p_updated_by: "agent",
      p_deleted: edit.op === "delete",
      p_version_id: ulid(),
      p_author_id: null, // agent writes carry no human author
      p_change_set_id: changeSetId,
    });
    if (fErr) throw new Error(`failed to commit ${edit.path}: ${fErr.message}`);

    // Record the per-file change (backs the change feed + undo).
    const { error: chErr } = await supabase.from("file_changes").insert({
      id: ulid(),
      change_set_id: changeSetId,
      file_id: fileId,
      op: edit.op,
      before_version: beforeVersion,
      after_version: edit.op === "delete" ? null : afterVersion,
      diff: makeDiff(prior?.content ?? "", edit.op === "delete" ? "" : content),
    });
    if (chErr) throw new Error(`failed to record change for ${edit.path}: ${chErr.message}`);

    touched.push({
      fileId,
      path: edit.path,
      zone: edit.zone,
      op: edit.op,
      beforeVersion,
      afterVersion: edit.op === "delete" ? null : afterVersion,
    });
  }

  // Mark the source ingested: rewrite `status: pending` -> `status: ingested`
  // in the source's frontmatter. The orchestrator owns this human/system write
  // (updated_by = 'human'), so the zone-enforcement trigger does not block it.
  await markSourceIngested(supabase, args.workspaceId, args.sourceId);

  return { changeSetId, touched };
}

/** Flip the source's frontmatter status to `ingested` (best-effort commit). */
async function markSourceIngested(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const { data } = await supabase
    .from("files")
    .select("*")
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!data) return;
  const source = data as FileRow;
  const next = source.content.replace(/^(status:\s*)pending\s*$/m, "$1ingested");
  if (next === source.content) return; // no pending marker — leave it alone

  const { error } = await supabase.rpc("commit_file_version", {
    p_file_id: source.id,
    p_workspace_id: workspaceId,
    p_path: source.path,
    p_zone: source.zone,
    p_type: source.type,
    p_title: source.title,
    p_content: next,
    p_sha256: await sha256Of(next),
    p_expected_version: source.version,
    p_updated_by: "human", // orchestrator/system write, not the agent
    p_deleted: false,
    p_version_id: ulid(),
    p_author_id: null,
    p_change_set_id: null,
  });
  // A conflict here means a human touched the source mid-run; the wiki edits
  // above already landed, so losing the status flip is acceptable (the
  // idempotency key prevents a duplicate re-ingest either way).
  if (error && !error.message.includes("version_conflict")) {
    throw new Error(`failed to mark source ingested: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class NotImplemented extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplemented";
  }
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseRequest(body: unknown, headerKey: string | null): IngestRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.workspaceId !== "string" || b.workspaceId.length === 0) {
    throw new Error("workspaceId is required");
  }
  if (typeof b.sourceId !== "string" || b.sourceId.length === 0) {
    throw new Error("sourceId is required");
  }
  const mode = b.mode;
  if (mode !== undefined && mode !== "light" && mode !== "default" && mode !== "deep") {
    throw new Error("mode must be one of light | default | deep");
  }
  const ingestMode = b.ingestMode;
  if (ingestMode !== undefined && ingestMode !== "async" && ingestMode !== "realtime") {
    throw new Error("ingestMode must be one of async | realtime");
  }
  const idempotencyKey =
    typeof b.idempotencyKey === "string" ? b.idempotencyKey : (headerKey ?? undefined);

  return {
    workspaceId: b.workspaceId,
    sourceId: b.sourceId,
    mode: mode as RunMode | undefined,
    ingestMode: ingestMode as IngestRequest["ingestMode"],
    idempotencyKey,
  };
}

function titleFrom(edit: ProposedEdit, prior: MountedFile | undefined): string {
  // TODO(integrator): parse the title from the edit's YAML frontmatter; fall back
  // to the prior title or the filename slug.
  if (prior) return basename(prior.path);
  return basename(edit.path);
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lowercase hex SHA-256 — matches packages/core/src/utils/hash.ts exactly,
 *  so hashes written here agree with what the sync engine computes. */
async function sha256Of(content: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(content ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compact line diff for the change feed: common prefix/suffix trimmed, the
 * changed middle shown as `-`/`+` lines under one `@@` header. Not a full LCS
 * — sources/wiki edits are mostly appends, where this is exact anyway.
 */
function makeDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA).map((line) => `-${line}`);
  const added = b.slice(start, endB).map((line) => `+${line}`);
  const header = `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`;
  return [header, ...removed, ...added].join("\n");
}

// Crockford-base32 ULID (time-sortable, 26 chars) — same format as
// packages/core/src/utils/ulid.ts, so ids minted here sort with the rest.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  let time = Date.now();
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ULID_ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let out = timeChars.join("");
  for (let i = 0; i < 16; i++) {
    out += ULID_ALPHABET[rand[i] % 32];
  }
  return out;
}
