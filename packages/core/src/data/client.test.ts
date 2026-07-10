import { describe, expect, it } from "vitest";
import {
  SUPABASE_KEY_ENV,
  SUPABASE_URL_ENV,
  createSupabaseClient,
  loadSupabaseConfigFromEnv,
} from "./client.js";

describe("loadSupabaseConfigFromEnv", () => {
  it("reads url + key from the provided env record", () => {
    const config = loadSupabaseConfigFromEnv({
      [SUPABASE_URL_ENV]: "https://xyz.supabase.co",
      [SUPABASE_KEY_ENV]: "anon-key",
    });
    expect(config).toEqual({ url: "https://xyz.supabase.co", key: "anon-key" });
  });

  it("throws naming every missing variable (never hardcodes)", () => {
    expect(() => loadSupabaseConfigFromEnv({})).toThrow(
      new RegExp(`${SUPABASE_URL_ENV}.*${SUPABASE_KEY_ENV}`),
    );
    expect(() =>
      loadSupabaseConfigFromEnv({ [SUPABASE_URL_ENV]: "https://xyz.supabase.co" }),
    ).toThrow(SUPABASE_KEY_ENV);
  });
});

describe("createSupabaseClient", () => {
  it("constructs a typed client exposing the canonical tables", () => {
    const client = createSupabaseClient({
      url: "https://xyz.supabase.co",
      key: "anon-key",
    });
    // Construction is offline (no network until a query runs); a `.from` handle
    // on a canonical table proves the wrapper is wired with the schema generic.
    expect(typeof client.from).toBe("function");
    expect(client.from("files")).toBeDefined();
  });
});
