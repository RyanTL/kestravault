# Contributing to KestraVault

Thanks for your interest! KestraVault is open source and contributions — from humans
and AI agents alike — are welcome.

## Before you start

- Read **[AGENTS.md](AGENTS.md)** — the single source of truth for how anyone
  (Claude Code, Codex, or a human) works in this repo.
- Skim **[plan/README.md](plan/README.md)** for the product + architecture.
- For anything beyond a small fix, **open an issue first** so we can agree on the
  approach before you build.

## Development setup

Requires **Node ≥ 20** and **pnpm ≥ 9**.

```bash
pnpm install
pnpm dev:desktop        # run the desktop app
```

| Command | What it does |
|---|---|
| `pnpm build` | Build packages in dependency order (turborepo). |
| `pnpm typecheck` | Type-check every package. **Must pass before a PR.** |
| `pnpm lint` | ESLint. **Must pass before a PR.** |
| `pnpm test` | Run the test suites. **Must pass before a PR.** |
| `pnpm format` | Apply Prettier formatting. |

## Pull requests

- **One scoped change per PR.** Keep them small and easy to review.
- Use **[Conventional Commits](https://www.conventionalcommits.org/)**
  (`feat(desktop): …`, `fix(core): …`, `docs: …`).
- Make sure `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass — CI runs all
  three on every PR.
- Match the surrounding code: comment density, naming, and idiom. Markdown is the
  source of truth — never swap CodeMirror for a lossy WYSIWYG editor.
- Respect package boundaries: `packages/core` stays platform-agnostic (no
  DOM/Electron/React Native imports). Talk through interfaces at boundaries rather
  than reaching into another area's internals.

## Security

Please **don't** file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
