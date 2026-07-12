import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Where the OpenAI Codex CLI lives. The ChatGPT-subscription provider reuses
// the user's `codex` login (the same way the Claude provider reuses the Claude
// Code login): we shell out to `codex exec`, so all we need is the binary.
//
// GUI apps on macOS/Linux launch with a minimal PATH that misses the usual
// install locations (Homebrew, npm globals, ~/.local/bin), so a plain
// spawn("codex") fails in packaged builds. We look through PATH plus the
// common install dirs once and cache the result.

let cached: string | null | undefined;

function candidateDirs(): string[] {
  const home = homedir();
  const fromPath = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  return [
    ...fromPath,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "n", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".codex", "bin"),
  ];
}

/** Absolute path of the `codex` CLI, or null when it isn't installed. */
export function resolveCodexExecutable(): string | null {
  if (cached !== undefined) return cached;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of candidateDirs()) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) {
        cached = p;
        return p;
      }
    }
  }
  cached = null;
  return null;
}

/** Drop the cache (e.g. after the user installs the CLI and re-checks). */
export function resetCodexCache(): void {
  cached = undefined;
}

/** Whether the Codex CLI is signed in (`codex login status` exits 0). */
export function codexLoggedIn(exe: string): boolean {
  try {
    execFileSync(exe, ["login", "status"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
