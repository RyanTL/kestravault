# Build resources

Input assets for [electron-builder](https://www.electron.build) (this is its
`buildResources` directory). These are committed; the generated installers in
`apps/desktop/dist/` are not.

| File | Purpose |
|---|---|
| `icon.png` | 1024×1024 app icon. electron-builder derives the macOS `.icns` and Windows `.ico` from it; Linux uses the PNG directly. |
| `logo.svg` / `logo-on-black.svg` | The KestraVault brand monogram — source of truth for the mark. |
| `make-icon.mjs` | Regenerates `icon.png` from scratch (no dependencies) — the KestraVault monogram (`logo.svg`) on a dark rounded tile. |
| `entitlements.mac.plist` | macOS hardened-runtime entitlements (V8 JIT + outbound network for the AI providers). |

## Regenerate the icon

```bash
node build/make-icon.mjs build/icon.png
```

To use your own artwork instead, drop a square PNG (≥512×512, ideally 1024×1024)
at `build/icon.png` and delete `make-icon.mjs`.
