import React from "react";
import { resolveWikiLink } from "@renderer/vault/paths";

// A tiny, dependency-free Markdown renderer for AI output. It builds real React
// nodes (never innerHTML), so there's no HTML-injection surface. Covers the
// blocks the model actually uses in chat: headings, bullet/numbered lists,
// fenced code, blockquotes, paragraphs, plus inline bold/italic/code/links —
// and clickable [[wiki-links]] that open the mentioned note.

interface LinkCtx {
  files: { name: string; path: string }[];
  onOpenNote: (path: string) => void;
}

interface MarkdownProps {
  text: string;
  /** When provided, [[note]] mentions become clickable and open the note. */
  files?: { name: string; path: string }[];
  onOpenNote?: (path: string) => void;
}

// Block links React would otherwise render as a `javascript:` / `data:` URL —
// model output and note content are untrusted. Returns the URL if safe
// (http/https/mailto, or an in-app relative/anchor link), else undefined so the
// caller renders plain text instead of a clickable link.
// Exported for unit tests; only `renderInline` uses it in app code.
export function safeHref(url: string): string | undefined {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^(#|\/|\.{1,2}\/)/.test(u)) return u; // anchors + relative paths
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // schemeless host → ok
  return undefined; // javascript:, data:, vbscript:, file:, … → blocked
}

// ---- inline ----
function renderInline(text: string, keyBase: string, ctx?: LinkCtx): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Order matters: code first (so its contents aren't re-parsed), then wiki-links
  // (before the standard link rule, since [[x]] superficially looks like [x]),
  // then links, bold, italic.
  const pattern =
    /(`[^`]+`)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={key} className="md-code-inline">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("[[")) {
      out.push(renderWikiLink(tok.slice(2, -2), key, ctx));
    } else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      const href = mm ? safeHref(mm[2]!) : undefined;
      // Unsafe scheme → render the link text only, never a clickable link.
      if (mm && href) out.push(<a key={key} href={href} target="_blank" rel="noreferrer noopener">{mm[1]}</a>);
      else if (mm) out.push(<span key={key}>{mm[1]}</span>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// `[[Target]]` or `[[Target|alias]]` → a clickable link that opens the note, or a
// faded span when nothing in the vault resolves (mirrors the editor's styling).
function renderWikiLink(inner: string, key: string, ctx?: LinkCtx): React.ReactNode {
  const [rawTarget, rawAlias] = inner.split("|");
  const target = (rawTarget ?? "").trim();
  const label = (rawAlias ?? rawTarget ?? "").trim();
  const path = ctx ? resolveWikiLink(target, ctx.files) : null;
  if (ctx && path) {
    return (
      <a
        key={key}
        className="md-wikilink"
        title={path}
        onClick={(e) => {
          e.preventDefault();
          ctx.onOpenNote(path);
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <span key={key} className="md-wikilink-unresolved" title="No matching note">
      {label}
    </span>
  );
}

// ---- blocks ----
export function Markdown({ text, files, onOpenNote }: MarkdownProps) {
  const ctx: LinkCtx | undefined = files && onOpenNote ? { files, onOpenNote } : undefined;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = `h${Math.min(level + 2, 6)}` as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Tag key={key++} className="md-h">
          {renderInline(h[2] ?? "", `h${key}`, ctx)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(buf.join(" "), `q${key}`, ctx)}
        </blockquote>,
      );
      continue;
    }

    // Lists (consume a run of list items; supports [ ]/[x] task items)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        const raw = (lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, "");
        const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
        if (task) {
          items.push(
            <li key={`li${key}-${i}`} className="md-task">
              <input type="checkbox" checked={task[1]!.toLowerCase() === "x"} readOnly />
              <span>{renderInline(task[2] ?? "", `t${i}`, ctx)}</span>
            </li>,
          );
        } else {
          items.push(<li key={`li${key}-${i}`}>{renderInline(raw, `l${i}`, ctx)}</li>);
        }
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={key++} className="md-list">{items}</ol>
        ) : (
          <ul key={key++} className="md-list">{items}</ul>
        ),
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (gather until blank / block start)
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6})\s|^\s*([-*+]|\d+\.)\s|^>\s?|^```/.test(lines[i] ?? "")
    ) {
      buf.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(buf.join(" "), `p${key}`, ctx)}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
