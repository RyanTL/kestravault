// Shared CORS headers for KestraVault edge functions.
//
// The ingest function is normally invoked server-side by the orchestrator, but
// it may also be called from the desktop/mobile clients, so we answer browser
// preflight requests. Lock `Access-Control-Allow-Origin` down to your app's
// origin in production instead of "*".

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Build a JSON `Response` with CORS headers applied. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
