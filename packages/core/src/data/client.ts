import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

/**
 * The Realtime WebSocket transport type. On runtimes without a global
 * `WebSocket` (Electron's main process / Node < 22), the host injects a
 * WebSocket implementation (e.g. the `ws` package) so core never has to import
 * a platform-specific one.
 */
type RealtimeTransport = NonNullable<SupabaseClientOptions<"public">["realtime"]>["transport"];

/**
 * Thin, platform-agnostic wrapper around `@supabase/supabase-js` typed against the
 * canonical `Database` schema (./database.types.ts). It only constructs a typed
 * client — no DOM, Electron, or RN imports — so desktop, mobile, and the cloud
 * orchestrator all build their repos on the same handle. See plan/architecture.md.
 */

/** A typed Supabase client scoped to the KestraVault canonical schema. */
export type KestravaultSupabaseClient = SupabaseClient<Database>;

export interface SupabaseConfig {
  /** Project URL, e.g. `https://xyz.supabase.co`. */
  url: string;
  /** API key (anon or service-role, depending on the host). */
  key: string;
  /**
   * Optional WebSocket implementation for Realtime, injected by hosts whose
   * runtime has no global `WebSocket` (Electron main process, Node < 22).
   * Browsers, React Native, and Node ≥ 22 leave this undefined and use the
   * built-in global. Typed as `unknown` because host WebSocket packages (e.g.
   * `ws`) aren't structurally assignable to supabase-js's transport type — the
   * cast happens once, internally, at the injection seam below.
   */
  transport?: unknown;
}

/** Default env var names read by {@link loadSupabaseConfigFromEnv}. */
export const SUPABASE_URL_ENV = "SUPABASE_URL";
export const SUPABASE_KEY_ENV = "SUPABASE_KEY";

/** A source of environment variables — `process.env` shape, but injectable. */
export type EnvRecord = Record<string, string | undefined>;

function ambientEnv(): EnvRecord {
  // Read the ambient `process.env` if the host provides one; otherwise return an
  // empty record so callers on RN/web pass their own. Never throws.
  return typeof process !== "undefined" && process ? process.env : {};
}

/**
 * Build a {@link SupabaseConfig} from environment variables. Reads `SUPABASE_URL`
 * and `SUPABASE_KEY` from the given record (defaults to the ambient `process.env`)
 * and throws a clear error if either is missing — secrets are NEVER hardcoded.
 */
export function loadSupabaseConfigFromEnv(env: EnvRecord = ambientEnv()): SupabaseConfig {
  const url = env[SUPABASE_URL_ENV];
  const key = env[SUPABASE_KEY_ENV];
  if (!url || !key) {
    const missing = [
      url ? null : SUPABASE_URL_ENV,
      key ? null : SUPABASE_KEY_ENV,
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new Error(
      `Missing Supabase configuration: ${missing}. Set it in the environment ` +
        `(do not hardcode keys).`,
    );
  }
  return { url, key };
}

/** Create a typed Supabase client from an explicit {@link SupabaseConfig}. */
export function createSupabaseClient(config: SupabaseConfig): KestravaultSupabaseClient {
  return createClient<Database>(config.url, config.key, {
    auth: {
      // Core has no session-persistence story of its own; each host wires auth.
      persistSession: false,
      autoRefreshToken: false,
    },
    // Only set a transport when the host injected one; otherwise let supabase-js
    // use the ambient global `WebSocket`.
    ...(config.transport
      ? { realtime: { transport: config.transport as RealtimeTransport } }
      : {}),
  });
}

/** Convenience: read config from the environment and create a typed client. */
export function createSupabaseClientFromEnv(env?: EnvRecord): KestravaultSupabaseClient {
  return createSupabaseClient(loadSupabaseConfigFromEnv(env));
}
