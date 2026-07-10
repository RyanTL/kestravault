import type { LocalFile, LocalVaultStore } from "./types.js";

/**
 * In-memory {@link LocalVaultStore} — the test double and the seed for hosts
 * without a real filesystem (mobile keeps its mirror in storage it manages).
 * Same conventions as the in-memory repos: hands back copies, never references.
 */
export class InMemoryLocalVaultStore implements LocalVaultStore {
  private readonly byPath = new Map<string, string>();

  constructor(files: LocalFile[] = []) {
    for (const file of files) this.byPath.set(file.path, file.content);
  }

  async list(): Promise<LocalFile[]> {
    return [...this.byPath.entries()].map(([path, content]) => ({ path, content }));
  }

  async read(path: string): Promise<string | null> {
    return this.byPath.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.byPath.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.byPath.delete(path);
  }
}
