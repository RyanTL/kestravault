# Security Policy

KestraVault handles two sensitive things directly: your **notes** and your **AI
provider API keys**. We take both seriously. This document explains how we
protect them and how to report a problem.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[**Report a vulnerability**](https://github.com/RyanTL/kestravault/security/advisories/new)
flow (the **Security** tab → *Advisories* → *Report a vulnerability*). This opens
a private channel with the maintainers.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected version / commit and your OS.

We aim to acknowledge reports within **5 business days** and to keep you updated
as we work on a fix. We'll credit you in the advisory unless you'd rather stay
anonymous. KestraVault has no paid bug-bounty program yet — reports are handled on a
good-faith basis.

## What we consider in scope

- The desktop app (`apps/desktop`) — Electron main/preload/renderer.
- The shared logic in `packages/core`.
- Anything that could expose a user's **API keys**, read/write files **outside the
  chosen vault**, or run **untrusted code** in the app.

Out of scope: issues that require a already-compromised machine or a malicious OS
account; vulnerabilities in third-party AI providers themselves; and the
not-yet-shipped cloud sync backend.

## How KestraVault protects your data

**API keys (bring-your-own-key).**
- Keys are encrypted at rest using the operating-system keychain via Electron
  [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
  (Keychain on macOS, libsecret on Linux, DPAPI on Windows).
- They are stored and used **only in the main process**. The renderer (the UI)
  can save or clear a key and ask *whether* one exists, but the plaintext key is
  **never returned across the IPC boundary** and is **never written to
  `localStorage`**.
- A key is only ever sent to the provider endpoint you configured — KestraVault
  operates no servers of its own.
- If no OS keychain is available, KestraVault falls back to a permission-restricted
  (`0600`) file in the app's user-data directory and surfaces a warning in
  Settings rather than silently storing the key in the clear.

**Your notes.**
- Notes are plain markdown files in a vault folder you choose. All filesystem
  access goes through a small IPC surface that refuses any path escaping the
  current vault.
- With a local model (Ollama / LM Studio) your note content never leaves the
  machine.

**Electron hardening.**
- `contextIsolation` is on and the renderer has no Node integration.
- A Content-Security-Policy restricts scripts to the app's own bundle.
- A navigation guard prevents the app window from being navigated or redirected
  away from its own UI; external links open in your browser, and only
  `http(s)`/`mailto` URLs are ever handed to the OS.
- Markdown rendered from AI output or notes cannot produce `javascript:` /
  `data:` links.

## Keeping your install safe

- Only enter API keys you obtained from the provider's official console.
- Be deliberate about which folders you open as vaults and which notes you paste
  into the AI — prompts are sent to whichever provider you've selected.
