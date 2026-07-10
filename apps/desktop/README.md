# @kestravault/desktop

The KestraVault desktop client: an **Electron** shell wrapping a **React (DOM)** UI
with the **CodeMirror 6** markdown editor. See
[`plan/architecture.md`](../../plan/architecture.md).

> **Status: runnable.** A local-first markdown vault with built-in
> bring-your-own-model AI chat. Cloud sync and the autonomous wiki agent are on
> the [roadmap](../../plan/roadmap.md).

## Layout

A dark, Obsidian-style workbench:

- **Left — Vault tree.** Your real `.md` files, with a vault switcher, bookmarks,
  search, and reveal-in-Finder.
- **Center — Editor.** CodeMirror 6 with live preview, wiki-links, backlinks, an
  outline, and a slash menu. Markdown is the source of truth — no WYSIWYG.
- **Right — AI panel + graph.** Bring-your-own-model chat and an Obsidian-style
  graph view.

## Structure

```
electron.vite.config.ts   # main / preload / renderer build targets
src/
  main/
    index.ts              # Electron main: window lifecycle + IPC + nav guard
    vault.ts              # vault registry + sandboxed filesystem access
    ai.ts                 # AI bridge: subscription / Anthropic / OpenAI-compatible
    secrets.ts            # API keys, encrypted at rest via OS keychain (safeStorage)
  preload/index.ts        # context-bridge: the typed, minimal renderer surface
  renderer/
    index.html            # CSP lives here
    src/
      App.tsx             # workbench composition + state
      components/         # FileExplorer, EditorGroup, AIChatPanel, GraphView, Settings, …
      vault/              # hooks + logic: useVault, useAi, useSettings, search, graph, …
      styles.css          # dark theme
```

## Scripts

```
pnpm --filter @kestravault/desktop dev         # launch the Electron window
pnpm --filter @kestravault/desktop typecheck   # tsc (node + web projects)
pnpm --filter @kestravault/desktop lint        # eslint
pnpm --filter @kestravault/desktop build       # production bundle (electron-vite)
```

## Notes

- **Bring your own model.** Configure the provider in **Settings → AI model**:
  a Claude subscription (OAuth, no key), an API key (Anthropic / OpenAI /
  OpenRouter), or a local model (Ollama / LM Studio). Keys are stored encrypted
  in the main process — see the repo [SECURITY.md](../../SECURITY.md).
- **Vault location.** First run seeds `~/KestraVault Vault`. The folder name is kept
  distinct from the repo checkout so a case-insensitive filesystem doesn't treat
  the source tree as a vault.
- **Packaging.** `pnpm --filter @kestravault/desktop build:mac` (or `build:win` /
  `build:linux`) produces installers via electron-builder — config in
  [`electron-builder.yml`](electron-builder.yml), resources in [`build/`](build/).
  Builds are unsigned until you add signing credentials.
