# KestraVault landing page

Static site — no build step. `index.html` + `styles.css` + `main.js` + `assets/`.

## Preview locally

```bash
python3 -m http.server 4321 --directory apps/website
```

## Deploy (launch day — see `plan/launch-v1.md`)

Point Vercel / GitHub Pages / any static host at this directory. **Do not deploy
before the repo flips public** — that's a launch-day step.

## Download buttons

`main.js` queries `https://api.github.com/repos/RyanTL/kestravault/releases/latest`
at page load and fills the four download cards from the release assets
(electron-builder filenames embed the version, so nothing is hardcoded). While
the repo is private / has no releases the API 404s and the page falls back to a
"coming soon" state linking to the releases page. No rebuild needed per release.

## Screenshots

`assets/app-*.png` are captured from the real app via the demo harness at
`apps/desktop/src/renderer/demo.html` (`?shot=editor|hero|graph`), e.g.:

```bash
pnpm dev:desktop   # dev server on :5173
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1440,900 --virtual-time-budget=9000 \
  --screenshot=apps/website/assets/app-hero.png \
  "http://localhost:5173/demo.html?shot=hero"
```
