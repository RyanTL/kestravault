# publish/ — note publishing, the platform-agnostic half

Implements the pure core of **Feature B — note publishing via public link**
(`plan/sync-collab-open-core.md` §3). The public web render route is blocked on
the web app (O4) and deliberately does **not** exist yet; this module is
everything that route will need that can be built and unit-tested today.

## What lives here

`toPublishedView(document, deps)` — a pure, deterministic function from a
notes-zone markdown document (frontmatter + body) to the `PublishedView` an
anonymous reader is allowed to see:

- **Zero graph leak (load-bearing).** Every `[[wikilink]]` is flattened to its
  plain display text — no href, no resolution. `[[title|alias]]` renders only
  the alias; `[[page#Section]]` renders only `page` (a private page's section
  headings are its internal structure). Publishing one note can never reveal the
  title, existence, or content of anything it links to.
- **Assets.** Embeds (`![[img.png]]`) and relative markdown images are rewritten
  to public URLs minted by the injected `resolveAssetUrl` — only assets the note
  actually references are exposed (returned in `PublishedView.assets`).
  Unresolvable refs are dropped entirely, so workspace paths never leak.
- **Frontmatter is stripped.** Ids, tags, and dates stay private; only the title
  survives.
- Relative markdown links flatten to their text; only absolute external links
  (`http`/`https`/`mailto`) survive. Reference-style definitions pointing inside
  the workspace are removed. Code fences and inline code are left untouched.

Conservative defaults taken where the plan was silent: a document that cannot
prove `zone: notes` in its frontmatter is rejected (`NotPublishableError`);
non-http(s) URL schemes (including `data:`) are treated as internal and dropped;
in-note `#anchor` links flatten to text.

## How the future web route consumes this

1. Route receives `GET /p/<token>` (anonymous — no account, no session).
2. It calls `NotePublishRepo.fetchPublishedByToken(token)` (see
   `../data/publishing.ts`), which hits the `fetch_published_note` RPC — the
   token-gated anonymous read path defined in the `note_publishing` migration.
   Unpublished/unknown/revoked tokens return `null` → render 404.
3. It runs the returned markdown through `toPublishedView`, passing a
   `resolveAssetUrl` that mints Supabase Storage public/signed URLs for the
   workspace's assets (and returns `null` for anything it doesn't own).
4. It renders `PublishedView.markdown` read-only, with
   `<meta name="robots" content="noindex">` (default posture: unlisted +
   noindex) and no auth, no agent involvement — publishing never feeds the note
   to any AI.

The view is **live**: the route re-reads the current note on every request (no
snapshot — locked in the plan). Revocation is immediate: unpublish flips the row
and every subsequent fetch returns nothing; re-publishing mints a fresh token
(enforced server-side), so old links never come back to life.
