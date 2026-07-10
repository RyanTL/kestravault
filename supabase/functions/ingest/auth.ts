// Authorization for the `ingest` edge function.
//
// ingest runs with the service-role client, which BYPASSES row-level security —
// so this function, not RLS, is the access boundary. It accepts two callers and
// fails closed for everything else, before any service-role work runs:
//
//   1. The server-side orchestrator — presents the shared secret `INGEST_SECRET`
//      in the `x-ingest-secret` header. Never expose that secret to clients.
//   2. A desktop/mobile client — presents the signed-in user's JWT as
//      `Authorization: Bearer <jwt>`; the user must be a member of the target
//      workspace. (Owners count: they are backfilled into workspace_members, so
//      a plain membership lookup covers them.)
//
// Pure and dependency-free (Web-standard Headers/TextEncoder only): the real
// Supabase/JWT lookups are injected, so the decision logic is unit-testable
// without a live backend or the Deno runtime.

/** Thrown when a caller isn't authorized; `status` is the HTTP code to return. */
export class IngestAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "IngestAuthError";
  }
}

export interface IngestAuthDeps {
  /** The configured orchestrator secret, or undefined when none is set. */
  ingestSecret: string | undefined;
  /** Validate a bearer JWT; resolve the user id, or null when it's invalid. */
  getUserId: (token: string) => Promise<string | null>;
  /** Whether `userId` is a member (or owner) of `workspaceId`. */
  isMember: (workspaceId: string, userId: string) => Promise<boolean>;
}

/**
 * Constant-time string comparison. Length is allowed to short-circuit (it isn't
 * secret); equal-length inputs are always compared in full so a match can't be
 * timed out character by character.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

/**
 * Authorize an ingest request. Resolves when the caller is the trusted
 * orchestrator or a member of `workspaceId`; otherwise throws {@link
 * IngestAuthError}. Presenting `x-ingest-secret` selects the orchestrator path
 * exclusively (a wrong secret is rejected, never retried as a user).
 */
export async function authorizeIngest(
  headers: Headers,
  workspaceId: string,
  deps: IngestAuthDeps,
): Promise<void> {
  const providedSecret = headers.get("x-ingest-secret");
  if (providedSecret !== null) {
    if (deps.ingestSecret && timingSafeEqual(providedSecret, deps.ingestSecret)) return;
    throw new IngestAuthError("invalid ingest secret", 401);
  }

  const authorization = headers.get("Authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? "";
  if (!token) {
    throw new IngestAuthError("missing bearer token or ingest secret", 401);
  }

  const userId = await deps.getUserId(token);
  if (!userId) {
    throw new IngestAuthError("invalid or expired token", 401);
  }
  if (!(await deps.isMember(workspaceId, userId))) {
    throw new IngestAuthError("not a member of this workspace", 403);
  }
}
