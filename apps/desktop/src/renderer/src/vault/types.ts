import type { EffectivePrivacy } from "@kestravault/core";

// A markdown file or folder in the vault tree, mirroring the shape the preload
// bridge returns from the main process.
export type VaultNode =
  | { kind: "file"; name: string; path: string; private?: boolean; privacy: EffectivePrivacy }
  | { kind: "dir"; name: string; path: string; children: VaultNode[]; privacy: EffectivePrivacy };

// A known vault, as listed in the vault switcher.
export interface VaultInfo {
  path: string;
  name: string;
  current: boolean;
}
