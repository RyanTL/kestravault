/** Path-level privacy for notes and folders.
 *
 * `cloud-ai-private` content still syncs to the workspace but remote AI only
 * sees safe metadata. `local-only` content never syncs and is invisible to
 * remote AI. Local providers may read every mode because nothing leaves the
 * device.
 */

export type PrivacyMode = "public" | "cloud-ai-private" | "local-only";
export type CloudPrivacyMode = Exclude<PrivacyMode, "local-only">;
export type PrivacyTarget = "file" | "folder";
export type PrivacyRuleSource = "local" | "cloud" | "frontmatter";

export interface PrivacyRule {
  path: string;
  target: PrivacyTarget;
  mode: PrivacyMode;
  updatedAt: string;
  source?: PrivacyRuleSource;
}

export interface PrivacyRuleRecord extends PrivacyRule {
  workspaceId: string;
  updatedBy: string | null;
  deleted: boolean;
}

export interface EffectivePrivacy {
  mode: PrivacyMode;
  /** The strongest rule/source that produced this mode. */
  source: PrivacyRuleSource | "default";
  /** True when this path has an exact explicit rule. */
  explicit: boolean;
  /** True when the mode came from an ancestor folder. */
  inherited: boolean;
  /** The path of the rule that produced the mode, when any. */
  rulePath?: string;
  /** The target of the rule that produced the mode, when any. */
  ruleTarget?: PrivacyTarget;
}

export type RemoteAiAccess = "full" | "metadata" | "none";

export const PRIVACY_MODES: readonly PrivacyMode[] = [
  "public",
  "cloud-ai-private",
  "local-only",
];

export const CLOUD_PRIVACY_MODES: readonly CloudPrivacyMode[] = ["public", "cloud-ai-private"];

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === "string" && PRIVACY_MODES.includes(value as PrivacyMode);
}

export function isCloudPrivacyMode(value: unknown): value is CloudPrivacyMode {
  return typeof value === "string" && CLOUD_PRIVACY_MODES.includes(value as CloudPrivacyMode);
}

export function normalizePrivacyPath(path: string): string {
  const raw = path.replace(/\\/g, "/").trim();
  const absolute = raw.startsWith("/");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  // Vault paths are always relative. Absolute-looking inputs are normalized
  // into the equivalent relative path for rule comparisons, not filesystem I/O.
  return (absolute ? parts : parts).join("/");
}

export function privacyRuleKey(path: string, target: PrivacyTarget): string {
  return `${target}:${normalizePrivacyPath(path)}`;
}

function parentFolders(path: string, target: PrivacyTarget): string[] {
  const normalized = normalizePrivacyPath(path);
  const base = target === "folder" ? normalized : normalized.slice(0, normalized.lastIndexOf("/"));
  const folders: string[] = [];
  if (base === "" || !normalized.includes("/")) {
    folders.push("");
    return folders;
  }
  const parts = base.split("/").filter(Boolean);
  folders.push("");
  for (let i = 0; i < parts.length; i++) folders.push(parts.slice(0, i + 1).join("/"));
  return folders;
}

function ruleSortValue(rule: PrivacyRule): string {
  return rule.updatedAt || "";
}

function newest(rules: PrivacyRule[]): PrivacyRule | undefined {
  return rules.slice().sort((a, b) => ruleSortValue(b).localeCompare(ruleSortValue(a)))[0];
}

/**
 * Resolve a file/folder's effective privacy.
 *
 * Precedence:
 * 1. exact explicit path rule;
 * 2. inherited `local-only` folder rule, so old `private: true` cannot
 *    accidentally re-upload a locally-private subtree;
 * 3. legacy frontmatter `private: true`;
 * 4. closest inherited folder rule;
 * 5. public default.
 */
export function resolveEffectivePrivacy(
  path: string,
  target: PrivacyTarget,
  rules: PrivacyRule[],
  frontmatterPrivate = false,
): EffectivePrivacy {
  const normalized = normalizePrivacyPath(path);
  const liveRules = rules
    .filter((r) => isPrivacyMode(r.mode))
    .map((r) => ({ ...r, path: normalizePrivacyPath(r.path) }));

  const exact = newest(liveRules.filter((r) => r.path === normalized && r.target === target));
  if (exact) {
    return {
      mode: exact.mode,
      source: exact.source ?? "local",
      explicit: true,
      inherited: false,
      rulePath: exact.path,
      ruleTarget: exact.target,
    };
  }

  const folderPaths = new Set(parentFolders(normalized, target));
  const inheritedRules = liveRules
    .filter((r) => r.target === "folder" && folderPaths.has(r.path))
    .sort((a, b) => b.path.length - a.path.length || ruleSortValue(b).localeCompare(ruleSortValue(a)));
  const inherited = inheritedRules[0];

  if (inherited?.mode === "local-only") {
    return {
      mode: "local-only",
      source: inherited.source ?? "local",
      explicit: false,
      inherited: true,
      rulePath: inherited.path,
      ruleTarget: inherited.target,
    };
  }

  if (target === "file" && frontmatterPrivate) {
    return {
      mode: "cloud-ai-private",
      source: "frontmatter",
      explicit: false,
      inherited: false,
      rulePath: normalized,
      ruleTarget: "file",
    };
  }

  if (inherited) {
    return {
      mode: inherited.mode,
      source: inherited.source ?? "local",
      explicit: false,
      inherited: true,
      rulePath: inherited.path,
      ruleTarget: inherited.target,
    };
  }

  return { mode: "public", source: "default", explicit: false, inherited: false };
}

export function remoteAiAccessForPrivacy(
  mode: PrivacyMode,
  opts: { aiIsLocal?: boolean } = {},
): RemoteAiAccess {
  if (opts.aiIsLocal) return "full";
  if (mode === "public") return "full";
  if (mode === "cloud-ai-private") return "metadata";
  return "none";
}

export function shouldSyncPrivacyMode(mode: PrivacyMode): boolean {
  return mode !== "local-only";
}

export function isPrivacyPathMatch(
  rulePath: string,
  ruleTarget: PrivacyTarget,
  path: string,
): boolean {
  const rule = normalizePrivacyPath(rulePath);
  const subject = normalizePrivacyPath(path);
  if (ruleTarget === "file") return subject === rule;
  return rule === "" ? true : subject === rule || subject.startsWith(`${rule}/`);
}

export function hasLocalOnlyPrivacy(
  path: string,
  target: PrivacyTarget,
  rules: PrivacyRule[],
  frontmatterPrivate = false,
): boolean {
  return resolveEffectivePrivacy(path, target, rules, frontmatterPrivate).mode === "local-only";
}

export function cloudEligiblePrivacyRules(rules: PrivacyRule[]): PrivacyRule[] {
  return rules
    .filter((r) => isCloudPrivacyMode(r.mode))
    .map((r) => ({ ...r, path: normalizePrivacyPath(r.path) }));
}
