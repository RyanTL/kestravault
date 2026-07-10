# @kestravault/core

Platform-agnostic TypeScript shared by every KestraVault client. **No DOM, Electron,
or React Native imports** — this package must run unchanged in a browser, in
Node (Electron main), and in React Native.

## What's here today

- **`types/`** — the canonical data model (`Workspace`, `FileRecord`,
  `FileVersion`, `ChangeSet`, `FileChange`, `Asset`) plus the markdown
  frontmatter shapes, mirroring [`plan/data-model.md`](../../plan/data-model.md).
- **`utils/`** — `slugify`, `ulid`, `sourceFilename`, and `parseFrontmatter` /
  `serializeFrontmatter`.

## What's coming (separate tasks)

The file-level **3-way merge sync engine**, the **Supabase client**, and the
**agent/API client** (`ingestSource()` etc.) per
[`plan/architecture.md`](../../plan/architecture.md). They land here behind typed
interfaces so the apps never reach into another package's internals.

## Scripts

```
pnpm --filter @kestravault/core typecheck
pnpm --filter @kestravault/core lint
pnpm --filter @kestravault/core test
pnpm --filter @kestravault/core build
```
