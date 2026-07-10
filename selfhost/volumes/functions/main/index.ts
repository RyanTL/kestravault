// Main-service router for the self-hosted Supabase Edge Runtime.
//
// Kong strips /functions/v1, so a request for /functions/v1/ingest arrives
// here as /ingest; we spin up (or reuse) a worker for that function directory
// and hand the request over — the same shape as the official supabase/docker
// router. Runs on Deno inside supabase/edge-runtime; not part of the app's
// TypeScript build.

import * as jose from "https://deno.land/x/jose@v4.14.4/index.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET") ?? "";
const VERIFY_JWT = (Deno.env.get("VERIFY_JWT") ?? "true") === "true";

const JSON_HEADERS = { "Content-Type": "application/json" };

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ msg }), { status, headers: JSON_HEADERS });
}

async function isAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^[Bb]earer\s+/, "");
  if (!token) return false;
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(JWT_SECRET));
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  // CORS preflights pass through; the function itself answers them.
  if (VERIFY_JWT && req.method !== "OPTIONS" && !(await isAuthorized(req))) {
    return errorResponse(401, "Invalid JWT");
  }

  const url = new URL(req.url);
  const serviceName = url.pathname.split("/")[1];
  if (!serviceName) return errorResponse(400, "Missing function name in path");

  const servicePath = `/home/deno/functions/${serviceName}`;
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 400_000,
      noModuleCache: false,
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(req);
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : String(e));
  }
});
