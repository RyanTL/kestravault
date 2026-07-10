import { createRequire } from "node:module";

// Where the Claude Agent SDK's engine binary really lives.
//
// The SDK runs Claude in a child process: it resolves the platform's native
// `claude` binary (an optional dependency like
// @anthropic-ai/claude-agent-sdk-darwin-arm64) out of node_modules and spawns
// it. In a packaged app that resolution lands inside app.asar — a virtual
// archive only Electron's patched fs can see into; child_process.spawn cannot
// execute from it, so every subscription chat / agent op would fail with
// "binary exists but failed to launch". electron-builder already extracts the
// binary (executable bit) to app.asar.unpacked; we resolve it ourselves, map
// the path to the real file, and hand it to the SDK via its
// `pathToClaudeCodeExecutable` option. In dev there's no asar and the mapping
// is a no-op, so one code path serves both.

/** Rewrite a path inside app.asar to its extracted app.asar.unpacked twin. */
export function toUnpackedPath(p: string): string {
  return p.replace(/\bapp\.asar(?=[\\/])/, "app.asar.unpacked");
}

/**
 * Absolute path of the bundled `claude` engine binary for this platform, or
 * undefined when no platform package is installed (the SDK then falls back to
 * its own resolution, which still works in dev).
 */
export function resolveClaudeExecutable(): string | undefined {
  const req = createRequire(import.meta.url);
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return toUnpackedPath(req.resolve(`${pkg}/${exe}`));
    } catch {
      /* platform package not installed — try the next candidate */
    }
  }
  return undefined;
}
