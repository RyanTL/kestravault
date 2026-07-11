import { SKILLS_PATH } from "@renderer/vault/brain";
import type { VaultSkill } from "@renderer/vault/aiPrompts";

// User-defined skills: reusable agent instructions the user writes once and
// runs from the chat's "/" menu, alongside the built-in skills. Stored inside
// the vault at .kestravault/skills.json so they sync with it and stay
// editable by hand. Managed from Settings → AI guide.

export interface CustomSkill {
  id: string;
  label: string;
  /** One-line description shown in the skills menu. */
  description: string;
  /** The instruction the agent runs (it still follows the vault's AI guide). */
  prompt: string;
  /** Whether the skill operates on the currently open note. */
  needsNote?: boolean;
}

export function slugifySkillLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `custom-${slug || "skill"}`;
}

function isCustomSkill(s: unknown): s is CustomSkill {
  if (!s || typeof s !== "object") return false;
  const c = s as Partial<CustomSkill>;
  return (
    typeof c.id === "string" &&
    typeof c.label === "string" &&
    typeof c.prompt === "string" &&
    c.label.trim() !== "" &&
    c.prompt.trim() !== ""
  );
}

export async function readCustomSkills(): Promise<CustomSkill[]> {
  try {
    const raw = await window.api.vault.read(SKILLS_PATH);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomSkill).map((s) => ({
      id: s.id,
      label: s.label,
      description: typeof s.description === "string" ? s.description : "",
      prompt: s.prompt,
      needsNote: s.needsNote === true,
    }));
  } catch {
    return []; // missing or unreadable → no custom skills yet
  }
}

export async function writeCustomSkills(skills: CustomSkill[]): Promise<void> {
  await window.api.vault.write(SKILLS_PATH, JSON.stringify(skills, null, 2) + "\n");
}

/** Present a custom skill the way the chat panel expects skills to look. */
export function toVaultSkill(s: CustomSkill): VaultSkill {
  return {
    id: s.id,
    op: "custom",
    label: s.label,
    icon: "custom",
    description: s.description || "Custom skill",
    needsNote: s.needsNote,
    turnLabel: s.label,
    prompt: s.prompt,
  };
}
