// Deno tests for the ingest authorization boundary. Run with:
//   deno test supabase/functions/ingest/auth.test.ts
//
// NOTE: the repo's GitHub CI runs only the Node (pnpm) suite today, so these do
// not execute there yet — run them locally with Deno, or wire a Deno CI job.
// The decision logic is pure (injected deps), so no live Supabase is needed.

import { authorizeIngest, IngestAuthError, timingSafeEqual } from "./auth.ts";

const MEMBER_DEPS = {
  ingestSecret: "s3cret",
  getUserId: (token: string) => Promise.resolve(token === "good" ? "user-1" : null),
  isMember: (workspaceId: string, userId: string) =>
    Promise.resolve(workspaceId === "ws-1" && userId === "user-1"),
};

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

/** Assert the call rejects with an IngestAuthError carrying `status`. */
async function expectReject(
  run: () => Promise<void>,
  status: 401 | 403,
): Promise<void> {
  try {
    await run();
    throw new Error(`expected rejection with ${status}, but it resolved`);
  } catch (err) {
    if (!(err instanceof IngestAuthError)) throw err;
    if (err.status !== status) {
      throw new Error(`expected status ${status}, got ${err.status} (${err.message})`);
    }
  }
}

Deno.test("allows the orchestrator with a valid shared secret", async () => {
  await authorizeIngest(headers({ "x-ingest-secret": "s3cret" }), "ws-1", MEMBER_DEPS);
});

Deno.test("allows a workspace member with a valid JWT", async () => {
  await authorizeIngest(headers({ Authorization: "Bearer good" }), "ws-1", MEMBER_DEPS);
});

Deno.test("rejects a wrong shared secret (401)", async () => {
  await expectReject(
    () => authorizeIngest(headers({ "x-ingest-secret": "nope" }), "ws-1", MEMBER_DEPS),
    401,
  );
});

Deno.test("rejects the secret path when no secret is configured (401)", async () => {
  await expectReject(
    () =>
      authorizeIngest(headers({ "x-ingest-secret": "anything" }), "ws-1", {
        ...MEMBER_DEPS,
        ingestSecret: undefined,
      }),
    401,
  );
});

Deno.test("rejects when no auth is presented at all (401)", async () => {
  await expectReject(() => authorizeIngest(headers({}), "ws-1", MEMBER_DEPS), 401);
});

Deno.test("rejects an invalid/expired JWT (401)", async () => {
  await expectReject(
    () => authorizeIngest(headers({ Authorization: "Bearer bad" }), "ws-1", MEMBER_DEPS),
    401,
  );
});

Deno.test("rejects a valid user who is not a member (403 — the IDOR)", async () => {
  await expectReject(
    () => authorizeIngest(headers({ Authorization: "Bearer good" }), "other-ws", MEMBER_DEPS),
    403,
  );
});

Deno.test("timingSafeEqual matches only identical strings", () => {
  if (!timingSafeEqual("abc", "abc")) throw new Error("equal strings should match");
  if (timingSafeEqual("abc", "abd")) throw new Error("different strings must not match");
  if (timingSafeEqual("abc", "abcd")) throw new Error("different lengths must not match");
});
