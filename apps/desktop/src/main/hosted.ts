// KestraVault Cloud — the hosted Supabase endpoint baked into every build so
// downloaded/packaged apps can sync without any environment setup.
//
// The anon key is a PUBLIC client credential by design (Supabase's model:
// Row-Level Security is the security boundary, the anon key only identifies
// the project) — committing it is intentional and safe, same as shipping it
// inside every packaged app. See NEEDS-RYAN.md §1 / plan/sync-collab-open-core.md.
//
// Env vars still override these (dev against a staging project, CI, forks):
// KESTRAVAULT_SUPABASE_URL / KESTRAVAULT_SUPABASE_ANON_KEY.

export const HOSTED_SUPABASE_URL = "https://logmyyhpktrichwgumsd.supabase.co";

export const HOSTED_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvZ215eWhwa3RyaWNod2d1bXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNjcyMjIsImV4cCI6MjA5ODg0MzIyMn0.AsrAtOEqSUEOniJBT_bxvlNJq7yWghAvcqkTWbvZwIY";
