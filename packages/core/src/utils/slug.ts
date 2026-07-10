// Combining diacritical marks block (U+0300–U+036F): what NFKD separates out
// from accented letters, e.g. "é" -> "e" + U+0301.
const COMBINING_START = 0x300;
const COMBINING_END = 0x36f;

function stripDiacritics(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKD")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= COMBINING_START && cp <= COMBINING_END) continue;
    out += ch;
  }
  return out;
}

/**
 * Turn an arbitrary title into a URL/filename-safe slug.
 *
 *   slugify("Café déjà vu!") // "cafe-deja-vu"
 *
 * Diacritics are stripped, everything is lowercased, and any run of
 * non-alphanumeric characters collapses to a single hyphen.
 */
export function slugify(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
