import { useEffect, useRef, useState } from "react";
import type { VaultInfo } from "@renderer/vault/types";
import { ChevronDown, Check, Users } from "lucide-react";

// The vault name in the file-explorer header doubles as a switcher (Obsidian's
// "manage vaults" affordance): click it to drop down the list of known vaults,
// switch between them, or open/create another.

function ChevronDownIcon() {
  return <ChevronDown size={11} strokeWidth={1.8} aria-hidden />;
}

function CheckIcon() {
  return <Check size={13} strokeWidth={1.8} aria-hidden />;
}

interface VaultSwitcherProps {
  vaults: VaultInfo[];
  /** Fallback label before the vault list has loaded. */
  fallbackName: string;
  onSwitch: (path: string) => void;
  onOpenFolder: () => void;
  onCreate: () => void;
  onRemove: (path: string) => void;
  sharedWorkspaceName: string | null;
  onManageSharing: () => void;
}

export function VaultSwitcher({
  vaults,
  fallbackName,
  onSwitch,
  onOpenFolder,
  onCreate,
  onRemove,
  sharedWorkspaceName,
  onManageSharing,
}: VaultSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = vaults.find((v) => v.current);
  const label = current?.name || fallbackName || "Vault";

  return (
    <div className="vault-switcher" ref={ref}>
      <button
        className={`vault-switcher-btn${open ? " is-open" : ""}`}
        title="Switch vault"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="vault-switcher-name">{label}</span>
        <ChevronDownIcon />
      </button>

      {open ? (
        <div className="vault-menu" role="menu">
          <div className="vault-menu-label">Vaults</div>
          <ul className="vault-menu-list">
            {vaults.map((v) => (
              <li
                key={v.path}
                className={`vault-menu-item${v.current ? " is-current" : ""}`}
                role="menuitem"
                title={v.path}
                onClick={() => {
                  if (!v.current) onSwitch(v.path);
                  setOpen(false);
                }}
              >
                <span className="vault-menu-check">{v.current ? <CheckIcon /> : null}</span>
                <span className="vault-menu-text">
                  <span className="vault-menu-vname">{v.name}</span>
                  <span className="vault-menu-vpath">{v.path}</span>
                </span>
                {!v.current ? (
                  <button
                    className="vault-menu-remove"
                    title="Remove from list (keeps files)"
                    aria-label={`Remove ${v.name} from list`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(v.path);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            className="vault-menu-shared"
            onClick={() => {
              setOpen(false);
              onManageSharing();
            }}
          >
            <Users size={15} strokeWidth={1.7} aria-hidden />
            <span className="vault-menu-shared-text">
              <span className="vault-menu-shared-label">Shared vault</span>
              <span className="vault-menu-shared-name">
                {sharedWorkspaceName ?? "Set up collaboration"}
              </span>
            </span>
          </button>
          <div className="vault-menu-divider" />
          <button
            className="vault-menu-action"
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
          >
            Open folder as vault…
          </button>
          <button
            className="vault-menu-action"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            Create new vault…
          </button>
        </div>
      ) : null}
    </div>
  );
}
