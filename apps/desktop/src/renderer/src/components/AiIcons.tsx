// Small inline SVG icons for the AI features. Stroke-based, 1.5px, currentColor
// — consistent with the rest of the UI. The avatar is the KestraVault AI "mark".

// The KestraVault AI mark: a clean four-point spark with no orb. Stays
// monochrome — colors come from `currentColor`, so it flips correctly between
// the dark and light themes.
export function AiAvatar({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`ai-avatar${className ? " " + className : ""}`}
      style={{ width: size, height: size, color: "var(--accent)" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <path
          d="M12 2 L14.25 9.75 L22 12 L14.25 14.25 L12 22 L9.75 14.25 L2 12 L9.75 9.75 Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// Saved alternative: a small knowledge-graph constellation (linked nodes),
// reading as "linked notes / second brain". Kept available so the AI mark can
// be swapped by importing AiGraphMark instead of AiAvatar.
export function AiGraphMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`ai-avatar${className ? " " + className : ""}`}
      style={{ width: size, height: size, color: "var(--accent)" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        {/* edges */}
        <g stroke="currentColor" strokeWidth="1.1" opacity="0.4">
          <line x1="12" y1="12" x2="5" y2="6" />
          <line x1="12" y1="12" x2="19" y2="5" />
          <line x1="12" y1="12" x2="6" y2="19" />
          <line x1="12" y1="12" x2="19" y2="18" />
        </g>
        {/* outer nodes */}
        <g fill="currentColor" opacity="0.72">
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="5" r="2" />
          <circle cx="6" cy="19" r="2" />
          <circle cx="19" cy="18" r="2" />
        </g>
        {/* hub */}
        <circle cx="12" cy="12" r="3.1" fill="currentColor" />
      </svg>
    </span>
  );
}

import {
  X,
  SquarePen,
  ArrowUp,
  Square,
  ChevronDown,
  Maximize2,
  Minimize2,
  FileText,
  Library,
  Search,
  AlignLeft,
  WandSparkles,
  SquareCheckBig,
  Languages,
  Sparkles,
  Import,
  ScanSearch,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Semantic name → lucide glyph. The AI features reference icons by string
// (e.g. action chips carry an `icon` field), so this map is the single place
// that binds those names to the lucide set.
const ICONS: Record<string, LucideIcon> = {
  close: X,
  newchat: SquarePen,
  send: ArrowUp,
  stop: Square,
  chevron: ChevronDown,
  expand: Maximize2,
  collapse: Minimize2,
  doc: FileText,
  vault: Library,
  search: Search,
  summary: AlignLeft,
  wand: WandSparkles,
  check: SquareCheckBig,
  translate: Languages,
  sparkle: Sparkles,
  ai: Sparkles,
  ingest: Import,
  lint: ScanSearch,
  skills: Zap,
};

export function AiIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? Sparkles;
  // "stop" reads as a solid square (a stop button), unlike the stroked rest.
  const fill = name === "stop" ? "currentColor" : "none";
  return <Icon size={size} strokeWidth={1.8} fill={fill} aria-hidden />;
}
