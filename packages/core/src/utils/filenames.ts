import { slugify } from "./slug.js";

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build a dated source filename: `s-<date>-<slug>.md`. Keeping the date
 * prefix makes filenames greppable and a folder of captures chronological.
 *
 *   sourceFilename("Intro to Rust ownership", "2026-06-27")
 *   // "s-2026-06-27-intro-to-rust-ownership.md"
 *
 * `date` accepts a `YYYY-MM-DD` string (used as-is) or a `Date` (formatted).
 */
export function sourceFilename(title: string, date: Date | string = new Date()): string {
  const day = typeof date === "string" ? date : toIsoDate(date);
  return `s-${day}-${slugify(title)}.md`;
}
