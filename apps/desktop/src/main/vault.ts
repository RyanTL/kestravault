import { app } from "electron";
import { promises as fs } from "node:fs";
import { join, resolve, relative, dirname, basename, isAbsolute, sep, posix } from "node:path";
import {
  parseFrontmatter,
  serializeFrontmatter,
  resolveEffectivePrivacy,
  normalizePrivacyPath,
  privacyRuleKey,
  isPrivacyPathMatch,
  shouldSyncPrivacyMode,
  type EffectivePrivacy,
  type PrivacyMode,
  type PrivacyRule,
  type PrivacyTarget,
} from "@kestravault/core";

// A vault is a real folder of markdown on disk (the desktop "mirror" from
// plan/data-model.md). The app can know about several of them at once
// (Obsidian-style) but only one is *current* at a time; every file operation
// here is scoped to the current vault's root and refuses to touch anything
// outside it.

export type VaultNode =
  | {
      kind: "file";
      name: string;
      path: string;
      private?: boolean;
      privacy: EffectivePrivacy;
    }
  | { kind: "dir"; name: string; path: string; children: VaultNode[]; privacy: EffectivePrivacy };

/** A known vault, as surfaced to the renderer's vault switcher. */
export interface VaultInfo {
  path: string;
  name: string;
  current: boolean;
}

// ── Vault registry ───────────────────────────────────────────────────────────
// The set of known vaults plus which one is open, persisted to userData so the
// list — and the last-used vault — survive restarts. Held in memory so
// vaultRoot() can stay synchronous (path-safety + ai.ts call it inline).

interface RegistryEntry {
  path: string;
  addedAt: number;
}
interface Registry {
  vaults: RegistryEntry[];
  currentPath: string;
}

let registry: Registry | null = null;

function registryFile(): string {
  return join(app.getPath("userData"), "vaults.json");
}

// Default vault lives in the home folder. The folder name is deliberately
// distinct from the repo name ("kestravault"): on a case-insensitive filesystem
// (the macOS default) a folder named "KestraVault" resolves to the SAME directory
// as a dev checkout at ~/kestravault, so the app would walk its own source tree as
// the vault. The trailing word avoids that collision.
function defaultVaultPath(): string {
  return join(app.getPath("home"), "KestraVault Vault");
}

async function loadRegistry(): Promise<Registry> {
  if (registry) return registry;
  try {
    const raw = await fs.readFile(registryFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Registry>;
    const vaults = Array.isArray(parsed.vaults)
      ? parsed.vaults
          .filter((v): v is RegistryEntry => !!v && typeof v.path === "string")
          .map((v) => ({ path: resolve(v.path), addedAt: v.addedAt ?? Date.now() }))
      : [];
    let currentPath =
      typeof parsed.currentPath === "string" ? resolve(parsed.currentPath) : "";
    if (!vaults.some((v) => v.path === currentPath)) currentPath = vaults[0]?.path ?? "";
    if (vaults.length && currentPath) {
      registry = { vaults, currentPath };
      return registry;
    }
  } catch {
    // Missing or corrupt registry — fall through to a fresh default.
  }
  const def = defaultVaultPath();
  registry = { vaults: [{ path: def, addedAt: Date.now() }], currentPath: def };
  await saveRegistry();
  return registry;
}

async function saveRegistry(): Promise<void> {
  if (!registry) return;
  await fs.mkdir(dirname(registryFile()), { recursive: true });
  await fs.writeFile(registryFile(), JSON.stringify(registry, null, 2), "utf8");
}

function toInfo(): VaultInfo[] {
  const cur = registry?.currentPath ?? "";
  return (registry?.vaults ?? [])
    .slice()
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((v) => ({ path: v.path, name: basename(v.path), current: v.path === cur }));
}

/** Current vault root. Synchronous: reads the in-memory registry, falling back
 *  to the default path before the registry has loaded. */
export function vaultRoot(): string {
  return registry?.currentPath ?? defaultVaultPath();
}

/** Ensure a vault folder exists. Vaults always start empty — the onboarding
 *  wizard (renderer) scaffolds the user's own structure right after creation. */
async function ensureVaultAt(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

/** Load the registry and make sure the current vault's folder exists. Call
 *  once at startup before any vault IPC. */
export async function initVaults(): Promise<string> {
  await loadRegistry();
  await ensureVaultAt(registry!.currentPath);
  return registry!.currentPath;
}

/** Ensure the *current* vault's folder exists. Cheap to call on every read. */
export async function ensureVault(): Promise<string> {
  await loadRegistry();
  await ensureVaultAt(vaultRoot());
  return vaultRoot();
}

/** Every known vault, with the current one flagged. */
export async function listVaults(): Promise<VaultInfo[]> {
  await loadRegistry();
  return toInfo();
}

/** Switch to an already-known vault (or register it if new), making it current. */
export async function switchVault(path: string): Promise<string> {
  return registerVault(path);
}

/** Register a folder as a vault and make it current. Existing content is
 *  always left exactly as-is. */
export async function registerVault(path: string): Promise<string> {
  await loadRegistry();
  const abs = resolve(path);
  await ensureVaultAt(abs);
  if (!registry!.vaults.some((v) => v.path === abs)) {
    registry!.vaults.push({ path: abs, addedAt: Date.now() });
  }
  registry!.currentPath = abs;
  await saveRegistry();
  return abs;
}

/** Forget a vault (never deletes it from disk). The open vault can't be removed;
 *  returns the updated list either way. */
export async function removeVault(path: string): Promise<VaultInfo[]> {
  await loadRegistry();
  const abs = resolve(path);
  if (abs !== registry!.currentPath) {
    registry!.vaults = registry!.vaults.filter((v) => v.path !== abs);
    await saveRegistry();
  }
  return toInfo();
}

/**
 * Resolve a vault-relative path against `root`, refusing to escape it.
 *
 * Absolute inputs are rejected outright: a vault path is always relative, and an
 * absolute path on a *different* Windows drive (e.g. `C:\…` when the vault is on
 * `D:\`) survives the relative()/resolve() round-trip below — `relative()` can't
 * express a cross-drive path with `..`, so it returns the target verbatim and the
 * guard would pass. Blocking absolute paths up front closes that hole and is
 * harmless for legitimate relative paths.
 *
 * Exported for unit testing; callers use {@link safeJoin}.
 */
export function safeResolve(root: string, relPath: string): string {
  // Normalize incoming POSIX-style relative paths to the host separator.
  const native = relPath.split("/").join(sep);
  if (isAbsolute(native)) {
    throw new Error(`Path escapes the vault: ${relPath}`);
  }
  const abs = resolve(root, native);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || resolve(root, rel) !== abs) {
    throw new Error(`Path escapes the vault: ${relPath}`);
  }
  return abs;
}

/** Resolve a vault-relative path to an absolute one, refusing to escape root. */
function safeJoin(relPath: string): string {
  return safeResolve(vaultRoot(), relPath);
}

/** Vault-relative POSIX path for an absolute path inside the vault. */
function toRel(abs: string): string {
  return relative(vaultRoot(), abs).split(sep).join(posix.sep);
}

const IGNORED = new Set(["node_modules", ".git", ".obsidian", ".kestravault"]);

function isHidden(name: string): boolean {
  return name.startsWith(".") || IGNORED.has(name);
}

// The per-note Private flag (`private: true` in frontmatter) surfaced on the
// tree so the file list can mark private notes. Cheap scan of the leading
// frontmatter block — no YAML parse — mirroring isPrivate() in notePrivacy.ts.
async function readPrivateFlag(abs: string): Promise<boolean> {
  try {
    const text = await fs.readFile(abs, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return fm ? /^[ \t]*private[ \t]*:[ \t]*true[ \t]*$/im.test(fm[1] ?? "") : false;
  } catch {
    return false;
  }
}

const PRIVACY_FILE = ".kestravault/privacy.local.json";

export interface PrivacyTombstone {
  path: string;
  target: PrivacyTarget;
  updatedAt: string;
}

export interface LocalPrivacyStore {
  version: 1;
  rules: PrivacyRule[];
  tombstones: PrivacyTombstone[];
}

function emptyPrivacyStore(): LocalPrivacyStore {
  return { version: 1, rules: [], tombstones: [] };
}

function normalizeRule(rule: PrivacyRule): PrivacyRule {
  return {
    ...rule,
    path: normalizePrivacyPath(rule.path),
    source: rule.source ?? "local",
  };
}

function normalizeTombstone(t: PrivacyTombstone): PrivacyTombstone {
  return { ...t, path: normalizePrivacyPath(t.path) };
}

export async function readLocalPrivacyStore(): Promise<LocalPrivacyStore> {
  try {
    const raw = await fs.readFile(safeJoin(PRIVACY_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalPrivacyStore>;
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRule) : [],
      tombstones: Array.isArray(parsed.tombstones)
        ? parsed.tombstones.map(normalizeTombstone)
        : [],
    };
  } catch {
    return emptyPrivacyStore();
  }
}

export async function writeLocalPrivacyStore(store: LocalPrivacyStore): Promise<void> {
  const clean: LocalPrivacyStore = {
    version: 1,
    rules: store.rules.map(normalizeRule),
    tombstones: store.tombstones.map(normalizeTombstone),
  };
  await writeFile(PRIVACY_FILE, JSON.stringify(clean, null, 2));
}

export async function readPrivacyRules(): Promise<PrivacyRule[]> {
  return (await readLocalPrivacyStore()).rules;
}

function upsertTombstone(
  tombstones: PrivacyTombstone[],
  path: string,
  target: PrivacyTarget,
  updatedAt: string,
): PrivacyTombstone[] {
  const key = privacyRuleKey(path, target);
  return [
    ...tombstones.filter((t) => privacyRuleKey(t.path, t.target) !== key),
    { path: normalizePrivacyPath(path), target, updatedAt },
  ];
}

function removeTombstone(
  tombstones: PrivacyTombstone[],
  path: string,
  target: PrivacyTarget,
): PrivacyTombstone[] {
  const key = privacyRuleKey(path, target);
  return tombstones.filter((t) => privacyRuleKey(t.path, t.target) !== key);
}

async function updatePrivateFrontmatter(relPath: string, next: boolean | null): Promise<void> {
  if (!relPath.toLowerCase().endsWith(".md")) return;
  let content = "";
  try {
    content = await readFile(relPath);
  } catch {
    return;
  }
  const hasFrontmatter = /^---\r?\n/.test(content);
  const parsed = parseFrontmatter(content);
  const data =
    parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? { ...(parsed.data as Record<string, unknown>) }
      : {};
  if (next !== true && !hasFrontmatter && data["private"] !== true) return;
  if (next === true) data["private"] = true;
  else delete data["private"];
  await writeFile(
    relPath,
    Object.keys(data).length === 0 ? parsed.body : serializeFrontmatter(data, parsed.body),
  );
}

export async function setEntryPrivacy(
  path: string,
  target: PrivacyTarget,
  mode: PrivacyMode,
): Promise<void> {
  const normalized = normalizePrivacyPath(path);
  const updatedAt = new Date().toISOString();
  const store = await readLocalPrivacyStore();
  const key = privacyRuleKey(normalized, target);
  const nextRule: PrivacyRule = {
    path: normalized,
    target,
    mode,
    updatedAt,
    source: "local",
  };
  store.rules = [...store.rules.filter((r) => privacyRuleKey(r.path, r.target) !== key), nextRule];
  store.tombstones =
    mode === "local-only"
      ? upsertTombstone(store.tombstones, normalized, target, updatedAt)
      : removeTombstone(store.tombstones, normalized, target);
  await writeLocalPrivacyStore(store);

  if (target === "file") {
    if (mode === "cloud-ai-private") await updatePrivateFrontmatter(normalized, true);
    if (mode === "public") await updatePrivateFrontmatter(normalized, false);
  }
}

export async function clearEntryPrivacy(path: string, target: PrivacyTarget): Promise<void> {
  const normalized = normalizePrivacyPath(path);
  const updatedAt = new Date().toISOString();
  const key = privacyRuleKey(normalized, target);
  const store = await readLocalPrivacyStore();
  const removed = store.rules.find((r) => privacyRuleKey(r.path, r.target) === key);
  store.rules = store.rules.filter((r) => privacyRuleKey(r.path, r.target) !== key);
  store.tombstones =
    removed && removed.mode !== "local-only"
      ? upsertTombstone(store.tombstones, normalized, target, updatedAt)
      : removeTombstone(store.tombstones, normalized, target);
  await writeLocalPrivacyStore(store);
  if (target === "file") await updatePrivateFrontmatter(normalized, false);
}

export async function shouldSyncPathByPrivacy(
  path: string,
  rules: PrivacyRule[] = [],
): Promise<boolean> {
  const effective = resolveEffectivePrivacy(normalizePrivacyPath(path), "file", rules);
  return shouldSyncPrivacyMode(effective.mode);
}

async function remapPrivacyRules(fromPath: string, toPath: string): Promise<void> {
  const from = normalizePrivacyPath(fromPath);
  const to = normalizePrivacyPath(toPath);
  const now = new Date().toISOString();
  const store = await readLocalPrivacyStore();
  const moved: PrivacyRule[] = [];
  const kept: PrivacyRule[] = [];
  for (const rule of store.rules) {
    if (!isPrivacyPathMatch(from, rule.target, rule.path)) {
      kept.push(rule);
      continue;
    }
    const suffix = rule.path === from ? "" : rule.path.slice(from.length);
    const next = { ...rule, path: normalizePrivacyPath(to + suffix), updatedAt: now };
    moved.push(next);
    if (rule.mode !== "local-only") {
      store.tombstones = upsertTombstone(store.tombstones, rule.path, rule.target, now);
    }
  }
  store.rules = [...kept, ...moved];
  store.tombstones = store.tombstones.map((t) => {
    if (!isPrivacyPathMatch(from, t.target, t.path)) return t;
    const suffix = t.path === from ? "" : t.path.slice(from.length);
    return { ...t, path: normalizePrivacyPath(to + suffix), updatedAt: now };
  });
  await writeLocalPrivacyStore(store);
}

async function removePrivacyRulesForPath(path: string): Promise<void> {
  const normalized = normalizePrivacyPath(path);
  const now = new Date().toISOString();
  const store = await readLocalPrivacyStore();
  const kept: PrivacyRule[] = [];
  for (const rule of store.rules) {
    if (!isPrivacyPathMatch(normalized, rule.target, rule.path)) {
      kept.push(rule);
      continue;
    }
    if (rule.mode !== "local-only") {
      store.tombstones = upsertTombstone(store.tombstones, rule.path, rule.target, now);
    }
  }
  store.rules = kept;
  store.tombstones = store.tombstones.filter(
    (t) => !isPrivacyPathMatch(normalized, t.target, t.path),
  );
  await writeLocalPrivacyStore(store);
}

/** Recursively read the vault into a tree of dirs + markdown files. */
export async function readTree(): Promise<VaultNode[]> {
  await ensureVault();
  const privacyRules = await readPrivacyRules();
  async function walk(absDir: string): Promise<VaultNode[]> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const nodes: VaultNode[] = [];
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        const rel = toRel(abs);
        nodes.push({
          kind: "dir",
          name: entry.name,
          path: rel,
          children: await walk(abs),
          privacy: resolveEffectivePrivacy(rel, "folder", privacyRules),
        });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const rel = toRel(abs);
        const frontmatterPrivate = await readPrivateFlag(abs);
        const privacy = resolveEffectivePrivacy(rel, "file", privacyRules, frontmatterPrivate);
        const node: VaultNode = {
          kind: "file",
          name: entry.name,
          path: rel,
          privacy,
        };
        if (privacy.mode === "cloud-ai-private") node.private = true;
        nodes.push(node);
      }
    }
    // Folders first, then files, each alphabetical (case-insensitive).
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }
  return walk(vaultRoot());
}

export async function readFile(relPath: string): Promise<string> {
  return fs.readFile(safeJoin(relPath), "utf8");
}

export async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = safeJoin(relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Create a new file, auto-suffixing the name if it already exists. Returns the
 *  vault-relative path actually written. */
export async function createFile(relPath: string, content = ""): Promise<string> {
  const finalRel = await uniquePath(relPath);
  const abs = safeJoin(finalRel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return finalRel;
}

export async function createDir(relPath: string): Promise<string> {
  const finalRel = await uniquePath(relPath);
  await fs.mkdir(safeJoin(finalRel), { recursive: true });
  return finalRel;
}

export async function renameEntry(relPath: string, nextRelPath: string): Promise<string> {
  const from = safeJoin(relPath);
  const to = safeJoin(nextRelPath);
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
  await remapPrivacyRules(relPath, nextRelPath);
  return nextRelPath;
}

export async function deleteEntry(relPath: string): Promise<void> {
  await fs.rm(safeJoin(relPath), { recursive: true, force: true });
  await removePrivacyRulesForPath(relPath);
}

// ── Binary assets (images) ───────────────────────────────────────────────────
// Notes embed images with standard markdown (`![alt](assets/pic.png)`); the
// files live in the vault next to the notes and sync via Supabase Storage
// (main/sync.ts). Same path-safety rules as text files.

/** Extensions treated as embeddable/syncable binary assets. */
export const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
]);

/** Refuse to sync/paste assets past this size (keeps storage + IPC sane). */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export function isAssetPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot >= 0 && ASSET_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/** Read a binary vault file as base64 (renderer <img> uses a data: URL). */
export async function readBinary(relPath: string): Promise<string> {
  const buf = await fs.readFile(safeJoin(relPath));
  return buf.toString("base64");
}

/** Write a binary file from base64, auto-suffixing on collision. Returns the
 *  vault-relative path actually written. */
export async function writeBinary(relPath: string, base64: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`Asset too large (${Math.round(buf.byteLength / 1024 / 1024)} MB; max 20 MB)`);
  }
  const finalRel = await uniquePath(relPath);
  const abs = safeJoin(finalRel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return finalRel;
}

/** Read a binary vault file as a Buffer (asset sync uploads). */
export async function readBinaryRaw(relPath: string): Promise<Buffer> {
  return fs.readFile(safeJoin(relPath));
}

/** Write a binary vault file from a Buffer at an exact path (asset sync pulls). */
export async function writeBinaryRaw(relPath: string, data: Buffer): Promise<void> {
  const abs = safeJoin(relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

/** All asset files in the vault (vault-relative POSIX paths + byte sizes),
 *  skipping hidden/ignored folders — the walker for the asset sync pass. */
export async function listAssetFiles(): Promise<{ path: string; size: number }[]> {
  await ensureVault();
  const out: { path: string; size: number }[] = [];
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && isAssetPath(entry.name)) {
        const stat = await fs.stat(abs);
        if (stat.size <= MAX_ASSET_BYTES) out.push({ path: toRel(abs), size: stat.size });
      }
    }
  }
  await walk(vaultRoot());
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Append " 2", " 3", … (before the extension) until the path is free. */
async function uniquePath(relPath: string): Promise<string> {
  const exists = async (p: string) => {
    try {
      await fs.access(safeJoin(p));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(relPath))) return relPath;
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const base = basename(relPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${dir ? dir + "/" : ""}${stem} ${i}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not find a free filename");
}
