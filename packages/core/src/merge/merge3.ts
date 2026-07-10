// File-level, git-style 3-way text merge — the locked sync strategy for KestraVault
// (see plan/architecture.md "Sync & conflicts" and plan/data-model.md).
//
// Given a common ancestor (`base`) and two independently edited versions
// (`ours`, `theirs`), `merge3` produces a single merged document. Changes that
// touch different parts of the file are combined automatically; only genuinely
// overlapping edits become conflicts, marked with the standard git markers.
//
// Pure and platform-agnostic: no DOM / Electron / React Native / Node imports.

import { diffLines, type Hunk } from "./diff.js";

/** Options controlling conflict presentation. */
export interface Merge3Options {
  /** Label after the `<<<<<<<` marker for our side. Default `"ours"`. */
  ourLabel?: string;
  /** Label after the `>>>>>>>` marker for their side. Default `"theirs"`. */
  theirLabel?: string;
}

/** Outcome of a {@link merge3} call. */
export interface MergeResult {
  /** The merged document, including conflict markers when `clean` is false. */
  merged: string;
  /** True when the merge completed with zero conflicts. */
  clean: boolean;
  /** Number of conflicting regions (0 when `clean`). */
  conflicts: number;
}

interface SplitText {
  /** Line contents, without any trailing newline characters. */
  lines: string[];
  /** Whether the original text ended with a newline. */
  finalNewline: boolean;
}

type Side = "ours" | "theirs";
type SidedHunk = Hunk & { side: Side };

const MARKER = "<<<<<<<";
const SEPARATOR = "=======";
const MARKER_END = ">>>>>>>";

/**
 * Split text into lines, normalizing CRLF to LF so line endings never cause
 * spurious differences, and recording whether a final newline was present. An
 * empty string yields no lines (an empty document, not one blank line).
 */
function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], finalNewline: false };
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  const finalNewline = parts[parts.length - 1] === "";
  if (finalNewline) parts.pop();
  return { lines: parts, finalNewline };
}

/** Detect the dominant line ending from the first terminator, or null if none. */
function detectEol(text: string): "\r\n" | "\n" | null {
  const i = text.indexOf("\n");
  if (i === -1) return null;
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/** Reassemble content lines into text with the chosen ending and final newline. */
function joinLines(lines: readonly string[], eol: string, finalNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(eol) + (finalNewline ? eol : "");
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Perform a line-based 3-way merge of markdown (or any text).
 *
 * Behavior:
 * - **Identical sides** (`ours === theirs`) and **one-sided changes**
 *   (`base === ours` or `base === theirs`) short-circuit and return the exact
 *   input bytes — line endings and trailing newline preserved verbatim.
 * - Otherwise both sides are diffed against `base`. Two edits merge cleanly when
 *   at least one unchanged base line separates them; edits that share a base
 *   line (or are different insertions at the same point) overlap and produce a
 *   conflict.
 * - Conflicts are wrapped in standard markers:
 *   `<<<<<<< ours` / `=======` / `>>>>>>> theirs`.
 * - Line endings are normalized for comparison; the output uses the dominant
 *   ending of `ours` (falling back to `theirs`, then `base`, then LF). The
 *   trailing-newline flag follows `ours` (falling back the same way).
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  options: Merge3Options = {},
): MergeResult {
  // Byte-faithful fast paths: preserve the exact winning input (incl. endings).
  if (ours === theirs) return { merged: ours, clean: true, conflicts: 0 };
  if (base === ours) return { merged: theirs, clean: true, conflicts: 0 };
  if (base === theirs) return { merged: ours, clean: true, conflicts: 0 };

  const ourLabel = options.ourLabel ?? "ours";
  const theirLabel = options.theirLabel ?? "theirs";

  const baseInfo = splitLines(base);
  const oursInfo = splitLines(ours);
  const theirsInfo = splitLines(theirs);

  const eol = detectEol(ours) ?? detectEol(theirs) ?? detectEol(base) ?? "\n";
  const finalNewline =
    oursInfo.lines.length > 0
      ? oursInfo.finalNewline
      : theirsInfo.lines.length > 0
        ? theirsInfo.finalNewline
        : baseInfo.finalNewline;

  const baseLines = baseInfo.lines;
  const ourLines = oursInfo.lines;
  const theirLines = theirsInfo.lines;

  // Each side's changes against the common ancestor, merged into one stream
  // sorted by base position. Insertions sort before replacements at the same
  // position so an insertion adjacent to a replacement stays a separate (clean)
  // region rather than being swept into a conflict.
  const hunks: SidedHunk[] = [
    ...diffLines(baseLines, ourLines).map((h) => ({ ...h, side: "ours" as Side })),
    ...diffLines(baseLines, theirLines).map((h) => ({ ...h, side: "theirs" as Side })),
  ];
  hunks.sort(
    (a, b) =>
      a.baseStart - b.baseStart ||
      a.baseEnd - a.baseStart - (b.baseEnd - b.baseStart) ||
      (a.side === b.side ? 0 : a.side === "ours" ? -1 : 1),
  );

  const merged: string[] = [];
  let conflicts = 0;
  let oPos = 0; // base lines consumed so far
  let aPos = 0; // ours lines consumed so far (aligned to oPos)
  let bPos = 0; // theirs lines consumed so far (aligned to oPos)

  let k = 0;
  while (k < hunks.length) {
    const first = hunks[k]!;
    const regStart = first.baseStart;
    let regEnd = first.baseEnd;
    const group: SidedHunk[] = [first];
    k++;

    // Grow the region while the next hunk truly overlaps it: either it shares a
    // base line (`baseStart < regEnd`) or both the region and the next hunk are
    // insertions at the very same gap.
    while (k < hunks.length) {
      const h = hunks[k]!;
      const sharesLine = h.baseStart < regEnd;
      const samePointInsertion =
        regStart === regEnd && h.baseStart === regStart && h.baseEnd === h.baseStart;
      if (!sharesLine && !samePointInsertion) break;
      regEnd = Math.max(regEnd, h.baseEnd);
      group.push(h);
      k++;
    }

    // Copy the stable lines (unchanged in both sides) before this region.
    for (let s = oPos; s < regStart; s++) merged.push(baseLines[s]!);
    const stable = regStart - oPos;
    aPos += stable;
    bPos += stable;
    oPos = regStart;

    // Net length change each side applies across the region, used to slice the
    // matching window out of `ours` / `theirs`.
    let ourDelta = 0;
    let theirDelta = 0;
    for (const h of group) {
      const delta = h.sideEnd - h.sideStart - (h.baseEnd - h.baseStart);
      if (h.side === "ours") ourDelta += delta;
      else theirDelta += delta;
    }
    const span = regEnd - regStart;
    const ourLen = span + ourDelta;
    const theirLen = span + theirDelta;

    const baseSlice = baseLines.slice(regStart, regEnd);
    const ourSlice = ourLines.slice(aPos, aPos + ourLen);
    const theirSlice = theirLines.slice(bPos, bPos + theirLen);

    if (linesEqual(ourSlice, baseSlice)) {
      // Only theirs changed here.
      for (const line of theirSlice) merged.push(line);
    } else if (linesEqual(theirSlice, baseSlice)) {
      // Only ours changed here.
      for (const line of ourSlice) merged.push(line);
    } else if (linesEqual(ourSlice, theirSlice)) {
      // Both made the identical change.
      for (const line of ourSlice) merged.push(line);
    } else {
      conflicts++;
      merged.push(`${MARKER} ${ourLabel}`);
      for (const line of ourSlice) merged.push(line);
      merged.push(SEPARATOR);
      for (const line of theirSlice) merged.push(line);
      merged.push(`${MARKER_END} ${theirLabel}`);
    }

    oPos = regEnd;
    aPos += ourLen;
    bPos += theirLen;
  }

  // Trailing stable lines after the last region.
  for (let s = oPos; s < baseLines.length; s++) merged.push(baseLines[s]!);

  return {
    merged: joinLines(merged, eol, finalNewline),
    clean: conflicts === 0,
    conflicts,
  };
}
