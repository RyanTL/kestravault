// Minimal LCS-based line diff — the foundation the 3-way merge builds on.
// Pure, dependency-free, and platform-agnostic (no DOM / Node / RN imports).

/**
 * One contiguous change between a `base` line array and a derived ("side") line
 * array: the half-open base range `[baseStart, baseEnd)` was replaced by the
 * side range `[sideStart, sideEnd)`.
 *
 * - pure insertion → `baseStart === baseEnd`
 * - pure deletion  → `sideStart === sideEnd`
 * - replacement    → both ranges non-empty
 */
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

/** A matched pair of equal lines: `base[baseIndex] === side[sideIndex]`. */
export interface LineMatch {
  baseIndex: number;
  sideIndex: number;
}

/**
 * Longest common subsequence of two line arrays, returned as the matched index
 * pairs in increasing order. Equal lines anchor the match; everything between
 * anchors is a change.
 *
 * Common prefix and suffix lines are trimmed before the O(n·m) dynamic-program
 * runs, so a small edit inside a large file only costs work proportional to the
 * genuinely differing middle — the common case for note edits.
 */
export function lcsLines(base: readonly string[], side: readonly string[]): LineMatch[] {
  const matches: LineMatch[] = [];

  // Common prefix: lines that are identical from the top.
  let prefix = 0;
  const minLen = Math.min(base.length, side.length);
  while (prefix < minLen && base[prefix] === side[prefix]) {
    matches.push({ baseIndex: prefix, sideIndex: prefix });
    prefix++;
  }

  // Common suffix: lines identical from the bottom, not overlapping the prefix.
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Dynamic-program LCS over the differing middles only.
  const baseMid = base.slice(prefix, base.length - suffix);
  const sideMid = side.slice(prefix, side.length - suffix);
  const n = baseMid.length;
  const m = sideMid.length;

  if (n > 0 && m > 0) {
    // table[i][j] = LCS length of baseMid[i..] and sideMid[j..].
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      const row = table[i]!;
      const next = table[i + 1]!;
      for (let j = m - 1; j >= 0; j--) {
        row[j] = baseMid[i] === sideMid[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
      }
    }
    // Backtrack from the top to recover the actual matched pairs in order.
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (baseMid[i] === sideMid[j]) {
        matches.push({ baseIndex: prefix + i, sideIndex: prefix + j });
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }

  // Common suffix pairs (their indices live at the very end of both arrays).
  for (let k = suffix; k > 0; k--) {
    matches.push({ baseIndex: base.length - k, sideIndex: side.length - k });
  }

  return matches;
}

/**
 * Diff two line arrays into the list of {@link Hunk}s that turn `base` into
 * `side`. The gaps between LCS matches are the changes; matched lines produce no
 * hunk. Hunks are non-overlapping and sorted by `baseStart`.
 */
export function diffLines(base: readonly string[], side: readonly string[]): Hunk[] {
  const matches = lcsLines(base, side);
  const hunks: Hunk[] = [];
  let basePos = 0;
  let sidePos = 0;

  for (const match of matches) {
    if (match.baseIndex > basePos || match.sideIndex > sidePos) {
      hunks.push({
        baseStart: basePos,
        baseEnd: match.baseIndex,
        sideStart: sidePos,
        sideEnd: match.sideIndex,
      });
    }
    basePos = match.baseIndex + 1;
    sidePos = match.sideIndex + 1;
  }

  // Trailing change after the last match (or the whole thing when no matches).
  if (base.length > basePos || side.length > sidePos) {
    hunks.push({
      baseStart: basePos,
      baseEnd: base.length,
      sideStart: sidePos,
      sideEnd: side.length,
    });
  }

  return hunks;
}
