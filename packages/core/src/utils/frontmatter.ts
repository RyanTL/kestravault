import { parse, stringify } from "yaml";

export interface ParsedFrontmatter<T = Record<string, unknown>> {
  data: T;
  body: string;
}

// Opening fence at the very start of the doc, capturing the YAML block and
// consuming the closing fence plus its trailing newline.
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a markdown document into its parsed YAML frontmatter and its body.
 * When there's no frontmatter, `data` is `{}` and `body` is the input verbatim.
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  markdown: string,
): ParsedFrontmatter<T> {
  const match = FENCE.exec(markdown);
  if (match === null) {
    return { data: {} as T, body: markdown };
  }
  const full = match[0] ?? "";
  const captured = match[1] ?? "";
  const data = (parse(captured) ?? {}) as T;
  // Drop the single blank line conventionally left between fence and content.
  const body = markdown.slice(full.length).replace(/^\r?\n/, "");
  return { data, body };
}

/**
 * Serialize frontmatter + body back into a markdown document. Inverse of
 * {@link parseFrontmatter} for the data round-trip (whitespace is normalized).
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = stringify(data).trimEnd();
  const cleanBody = body.replace(/^\r?\n+/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}`;
}
