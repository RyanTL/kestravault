# @kestravault/mobile

The KestraVault mobile client: **React Native (Expo)** with the **CodeMirror 6**
editor running inside a `react-native-webview` (bridged to native for content,
change events, and toolbar actions) — the same approach Notion uses. Mobile is a
thin synced view (cached + queued offline; no on-disk folder). See
[`plan/architecture.md`](../../plan/architecture.md).

> **Status: shell scaffold only.** `src/index.ts` is a placeholder that imports
> `@kestravault/core` to prove the workspace wiring. The Expo app, the WebView editor
> bridge, and offline sync are follow-up tasks (one scoped PR each, per
> [`plan/agent-workflow.md`](../../plan/agent-workflow.md)).

## Scripts

```
pnpm --filter @kestravault/mobile typecheck
pnpm --filter @kestravault/mobile lint
pnpm --filter @kestravault/mobile start   # placeholder until the Expo app lands
```
