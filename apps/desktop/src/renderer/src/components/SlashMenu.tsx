import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import {
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code,
  Minus,
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Import,
  ScanSearch,
} from "lucide-react";
import { VAULT_SKILLS } from "@renderer/vault/aiPrompts";
import {
  closeSlashMenu,
  getSlashState,
  type SlashController,
  type SlashRender,
} from "@renderer/vault/livePreview";
import "./SlashMenu.css";

// Notion-style "/" command menu. The CodeMirror side (vault/livePreview.ts)
// owns the trigger and key routing; this component owns the command catalog,
// filtering, and the popup UI. Markdown stays the source of truth — every
// command just inserts plain markdown into the document.

interface SlashCommand {
  id: string;
  title: string;
  desc: string;
  group: string;
  /** Extra search terms beyond the title (e.g. "h1", "todo", "```"). */
  keywords: string[];
  /** The markdown cue shown faintly on the right (educational, Notion-ish). */
  hint: string;
  icon: ReactNode;
  /** Replace the "/query" range [from, to) with this command's markdown. */
  apply: (view: EditorView, from: number, to: number) => void;
}

const MENU_WIDTH = 300;
const GAP = 6;
const GROUP_ORDER = ["Basic blocks", "Inline", "Actions"];

/** Replace [from, to) and place the caret/selection relative to the insert. */
function applyEdit(
  view: EditorView,
  from: number,
  to: number,
  insert: string,
  selFrom: number,
  selTo: number = selFrom,
): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + selFrom, head: from + selTo },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  view.focus();
}

// A horizontal rule directly under text is a setext heading in markdown, so add
// a blank line above when the previous line has content.
function applyDivider(view: EditorView, from: number, to: number): void {
  const { doc } = view.state;
  const line = doc.lineAt(from);
  const prevHasText = line.number > 1 && doc.line(line.number - 1).text.trim() !== "";
  const insert = `${prevHasText ? "\n" : ""}---\n`;
  applyEdit(view, from, to, insert, insert.length);
}

// ---- Icons (monochrome, currentColor; neutral to match the redesign) -------

function HeadingIcon({ level }: { level: 1 | 2 | 3 }): ReactNode {
  const Icon = level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
  return <Icon className="slash-svg" aria-hidden />;
}

const ICON: Record<string, ReactNode> = {
  bullet: <List className="slash-svg" aria-hidden />,
  numbered: <ListOrdered className="slash-svg" aria-hidden />,
  todo: <ListChecks className="slash-svg" aria-hidden />,
  quote: <Quote className="slash-svg" aria-hidden />,
  code: <Code className="slash-svg" aria-hidden />,
  divider: <Minus className="slash-svg" aria-hidden />,
  bold: <Bold className="slash-svg" aria-hidden />,
  italic: <Italic className="slash-svg" aria-hidden />,
};

const COMMANDS: SlashCommand[] = [
  {
    id: "h1",
    title: "Heading 1",
    desc: "Big section heading.",
    group: "Basic blocks",
    keywords: ["h1", "heading", "title", "#", "big"],
    hint: "#",
    icon: <HeadingIcon level={1} />,
    apply: (v, f, t) => applyEdit(v, f, t, "# ", 2),
  },
  {
    id: "h2",
    title: "Heading 2",
    desc: "Medium section heading.",
    group: "Basic blocks",
    keywords: ["h2", "heading", "subtitle", "##"],
    hint: "##",
    icon: <HeadingIcon level={2} />,
    apply: (v, f, t) => applyEdit(v, f, t, "## ", 3),
  },
  {
    id: "h3",
    title: "Heading 3",
    desc: "Small section heading.",
    group: "Basic blocks",
    keywords: ["h3", "heading", "###"],
    hint: "###",
    icon: <HeadingIcon level={3} />,
    apply: (v, f, t) => applyEdit(v, f, t, "### ", 4),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    desc: "Create a simple bulleted list.",
    group: "Basic blocks",
    keywords: ["bulleted", "unordered", "list", "ul", "bullet", "-"],
    hint: "-",
    icon: ICON.bullet,
    apply: (v, f, t) => applyEdit(v, f, t, "- ", 2),
  },
  {
    id: "numbered",
    title: "Numbered list",
    desc: "Create a list with numbering.",
    group: "Basic blocks",
    keywords: ["numbered", "ordered", "list", "ol", "1."],
    hint: "1.",
    icon: ICON.numbered,
    apply: (v, f, t) => applyEdit(v, f, t, "1. ", 3),
  },
  {
    id: "todo",
    title: "To-do list",
    desc: "Track tasks with a checkbox.",
    group: "Basic blocks",
    keywords: ["todo", "to-do", "task", "checkbox", "check"],
    hint: "[ ]",
    icon: ICON.todo,
    apply: (v, f, t) => applyEdit(v, f, t, "- [ ] ", 6),
  },
  {
    id: "quote",
    title: "Quote",
    desc: "Capture a quotation.",
    group: "Basic blocks",
    keywords: ["quote", "blockquote", "citation", ">"],
    hint: ">",
    icon: ICON.quote,
    apply: (v, f, t) => applyEdit(v, f, t, "> ", 2),
  },
  {
    id: "code",
    title: "Code block",
    desc: "Capture a code snippet.",
    group: "Basic blocks",
    keywords: ["code", "codeblock", "fence", "snippet", "```", "pre"],
    hint: "```",
    icon: ICON.code,
    apply: (v, f, t) => applyEdit(v, f, t, "```\n\n```", 4),
  },
  {
    id: "divider",
    title: "Divider",
    desc: "Visually divide blocks.",
    group: "Basic blocks",
    keywords: ["divider", "horizontal", "rule", "hr", "separator", "line", "---"],
    hint: "---",
    icon: ICON.divider,
    apply: applyDivider,
  },
  {
    id: "bold",
    title: "Bold",
    desc: "Make the text you type bold.",
    group: "Inline",
    keywords: ["bold", "strong", "**", "b"],
    hint: "**",
    icon: ICON.bold,
    apply: (v, f, t) => applyEdit(v, f, t, "**bold**", 2, 6),
  },
  {
    id: "italic",
    title: "Italic",
    desc: "Italicize the text you type.",
    group: "Inline",
    keywords: ["italic", "emphasis", "*", "i"],
    hint: "*",
    icon: ICON.italic,
    apply: (v, f, t) => applyEdit(v, f, t, "*italic*", 1, 7),
  },
];

// Skill icons mirror the AI panel (Import = ingest, ScanSearch = lint).
const SKILL_ICON: Record<string, ReactNode> = {
  ingest: <Import className="slash-svg" aria-hidden />,
  lint: <ScanSearch className="slash-svg" aria-hidden />,
};

// Vault skills as slash commands. Unlike block commands they don't insert
// markdown — they clear the "/query" and hand off to the AI panel, which runs
// the tool-using agent against the active note.
function skillCommands(onRunSkill: (id: string) => void): SlashCommand[] {
  return VAULT_SKILLS.map((s) => ({
    id: `skill-${s.id}`,
    title: s.label,
    desc: s.description,
    group: "Actions",
    keywords: ["ai", "skill", "agent", s.id],
    hint: "AI",
    icon: SKILL_ICON[s.id],
    apply: (v: EditorView, from: number, to: number) => {
      v.dispatch({ changes: { from, to, insert: "" }, userEvent: "input.complete" });
      v.focus();
      onRunSkill(s.id);
    },
  }));
}

/** Subsequence match — every query char appears in order in the text. */
function fuzzy(query: string, text: string): boolean {
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Relevance of a command for a query; -1 means "no match, hide it". */
function score(query: string, cmd: SlashCommand): number {
  if (!query) return 1;
  const t = cmd.title.toLowerCase();
  if (t.startsWith(query)) return 5;
  if (cmd.keywords.includes(query)) return 4;
  if (cmd.keywords.some((k) => k.startsWith(query))) return 3;
  if (t.includes(query)) return 2;
  // Intentionally no loose "keyword contains query" tier — it surfaces noisy
  // mid-word hits (e.g. "to" matching "separator"). Title subsequence is enough.
  if (fuzzy(query, t)) return 0.5;
  return -1;
}

interface ScoredGroup {
  name: string;
  items: { cmd: SlashCommand; flatIndex: number }[];
}

/** Filter + group the commands; keep groups in order, best match first within. */
function buildResults(
  query: string,
  commands: SlashCommand[],
): { groups: ScoredGroup[]; flat: SlashCommand[] } {
  const q = query.toLowerCase();
  const scored = commands.map((cmd, i) => ({ cmd, i, s: score(q, cmd) })).filter((x) => x.s >= 0);

  const groups: ScoredGroup[] = [];
  const flat: SlashCommand[] = [];
  for (const name of GROUP_ORDER) {
    const inGroup = scored
      .filter((x) => x.cmd.group === name)
      .sort((a, b) => b.s - a.s || a.i - b.i);
    if (inGroup.length === 0) continue;
    const items = inGroup.map((x) => {
      const flatIndex = flat.length;
      flat.push(x.cmd);
      return { cmd: x.cmd, flatIndex };
    });
    groups.push({ name, items });
  }
  return { groups, flat };
}

interface SlashMenuProps {
  /** Live trigger state from CodeMirror, or null when the menu is closed. */
  render: SlashRender | null;
  /** The editor the menu acts on. */
  view: EditorView | null;
  /** Give CodeMirror's keymap a handle to drive selection/confirm/close. */
  registerController: (controller: SlashController | null) => void;
  /** When set, the "/" menu also offers vault skills (Ingest / Lint). */
  onRunSkill?: (id: string) => void;
}

export function SlashMenu({
  render,
  view,
  registerController,
  onRunSkill,
}: SlashMenuProps): ReactNode {
  const query = render?.query ?? "";
  const commands = useMemo(
    () => (onRunSkill ? [...COMMANDS, ...skillCommands(onRunSkill)] : COMMANDS),
    [onRunSkill],
  );
  const { groups, flat } = useMemo(() => buildResults(query, commands), [query, commands]);

  const [active, setActive] = useState(0);
  const [flip, setFlip] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Refs let CodeMirror's keymap reach the latest values without re-registering.
  const activeRef = useRef(0);
  const flatRef = useRef(flat);
  flatRef.current = flat;
  const viewRef = useRef(view);
  viewRef.current = view;

  const setActiveBoth = useCallback((next: number) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  // Reset the highlight whenever the query changes the result set.
  useEffect(() => {
    setActiveBoth(0);
  }, [query, setActiveBoth]);

  const run = useCallback((index: number): boolean => {
    const v = viewRef.current;
    if (!v) return false;
    const state = getSlashState(v); // read live range, not stale React state
    if (!state) return false;
    const cmd = flatRef.current[index];
    if (!cmd) return false;
    cmd.apply(v, state.from, state.to);
    return true; // applying removes the "/", which auto-closes the menu
  }, []);

  // Register the controller once; its methods read refs, so they stay current.
  useEffect(() => {
    const controller: SlashController = {
      move: (dir) => {
        const n = flatRef.current.length;
        if (n === 0) return;
        setActiveBoth((activeRef.current + dir + n) % n);
      },
      confirm: () => run(activeRef.current),
      close: () => {
        const v = viewRef.current;
        if (v) closeSlashMenu(v);
      },
    };
    registerController(controller);
    return () => registerController(null);
  }, [registerController, run, setActiveBoth]);

  const safeActive = flat.length ? Math.min(active, flat.length - 1) : 0;

  // Keep the highlighted row visible as you arrow through a long list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${safeActive}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [safeActive]);

  // Flip above the line if the menu would run off the bottom of the window.
  useLayoutEffect(() => {
    const coords = render?.coords;
    if (!coords || !menuRef.current) return;
    const height = menuRef.current.offsetHeight;
    setFlip(coords.bottom + GAP + height > window.innerHeight - 8);
  }, [render?.coords?.bottom, render?.coords?.top, flat.length]);

  if (!render || !view || !render.coords) return null;

  const { coords } = render;
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - MENU_WIDTH - 12));
  const top = flip ? coords.top - GAP : coords.bottom + GAP;

  return (
    <div
      ref={menuRef}
      className={`slash-menu${flip ? " is-flip" : ""}`}
      style={{ left, top, width: MENU_WIDTH }}
      // Keep editor focus (and the live "/" range) intact while interacting.
      onMouseDown={(e) => e.preventDefault()}
      role="listbox"
      aria-label="Insert block"
    >
      <div className="slash-list" ref={listRef}>
        {flat.length === 0 ? (
          <div className="slash-empty">No matching blocks</div>
        ) : (
          groups.map((g) => (
            <div className="slash-group" key={g.name}>
              <div className="slash-group-head">{g.name}</div>
              {g.items.map(({ cmd, flatIndex }) => (
                <button
                  key={cmd.id}
                  type="button"
                  data-idx={flatIndex}
                  role="option"
                  aria-selected={flatIndex === safeActive}
                  className={`slash-item${flatIndex === safeActive ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveBoth(flatIndex)}
                  onClick={() => run(flatIndex)}
                >
                  <span className="slash-tile">{cmd.icon}</span>
                  <span className="slash-text">
                    <span className="slash-title">{cmd.title}</span>
                    <span className="slash-desc">{cmd.desc}</span>
                  </span>
                  <span className="slash-hint">{cmd.hint}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="slash-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Select
        </span>
        <span>
          <kbd>esc</kbd> Dismiss
        </span>
      </div>
    </div>
  );
}
