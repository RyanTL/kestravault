import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Eraser,
  Sparkles,
  WandSparkles,
  SpellCheck,
  Minimize2,
  Maximize2,
  SlidersHorizontal,
  Languages,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  ArrowDownToLine,
  RotateCcw,
  Square,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "@renderer/components/Markdown";
import { AiAvatar } from "@renderer/components/AiIcons";
import {
  clearFormatting,
  convertBlock,
  insertLink,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
  type Block,
} from "@renderer/vault/editorCommands";
import {
  INLINE_AI_ACTIONS,
  LOCAL_ONLY_PAGE_REFUSAL,
  PRIVATE_PAGE_REFUSAL,
  inlineRewritePrompt,
  inlineRewriteSystem,
  type InlineAiAction,
} from "@renderer/vault/aiPrompts";
import type { AiRewrite } from "@renderer/vault/useAi";
import type { PrivacyMode } from "@kestravault/core";
import { setAiTargetRange, type SelectionRender } from "@renderer/vault/selectionMenu";
import "./SelectionMenu.css";

// The floating selection toolbar (Notion-style). The CodeMirror side
// (`vault/selectionMenu.ts`) reports the selection + anchor rect; this component
// owns the UI, the formatting/turn-into commands, and the inline-AI rewrite
// card. Every button edits plain markdown, keeping the document authoritative.

const GAP = 8;
const MARGIN = 8;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// ---- "Turn into" catalog ---------------------------------------------------

interface TurnItem {
  block: Block;
  label: string;
  icon: LucideIcon;
}

const TURN_ITEMS: TurnItem[] = [
  { block: "text", label: "Text", icon: Type },
  { block: "h1", label: "Heading 1", icon: Heading1 },
  { block: "h2", label: "Heading 2", icon: Heading2 },
  { block: "h3", label: "Heading 3", icon: Heading3 },
  { block: "bullet", label: "Bulleted list", icon: List },
  { block: "ordered", label: "Numbered list", icon: ListOrdered },
  { block: "todo", label: "To-do list", icon: ListChecks },
  { block: "quote", label: "Quote", icon: Quote },
];

const BLOCK_LABEL: Record<Block, string> = {
  text: "Text",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  bullet: "Bulleted list",
  ordered: "Numbered list",
  todo: "To-do list",
  quote: "Quote",
};

// Icon per inline-AI action (keys come from aiPrompts' INLINE_AI_ACTIONS).
const AI_ICON: Record<string, LucideIcon> = {
  improve: WandSparkles,
  grammar: SpellCheck,
  shorter: Minimize2,
  longer: Maximize2,
  tone: SlidersHorizontal,
  translate: Languages,
  ask: Sparkles,
};

// ---- component -------------------------------------------------------------

type Panel = "none" | "turn" | "skills";

interface Range {
  from: number;
  to: number;
}

interface AiState {
  action: InlineAiAction;
  instruction: string;
  /** Custom "Ask AI…" first shows a prompt box before streaming. */
  awaitingInput: boolean;
  text: string;
  streaming: boolean;
  error: boolean;
  /** Private note on a remote provider → show the refusal instead of streaming. */
  refusal: boolean;
}

interface SelectionMenuProps {
  render: SelectionRender | null;
  view: EditorView | null;
  /** Bound AI call (current model); null when no rewrite capability is wired. */
  aiRewrite: AiRewrite | null;
  /** Provider runs on-device (Ollama / LM Studio) → Private notes unrestricted. */
  aiIsLocal: boolean;
  /** Effective privacy for the open note. */
  notePrivacyMode: PrivacyMode;
}

export function SelectionMenu({
  render,
  view,
  aiRewrite,
  aiIsLocal,
  notePrivacyMode,
}: SelectionMenuProps): ReactNode {
  const [mode, setMode] = useState<"toolbar" | "ai">("toolbar");
  const [panel, setPanel] = useState<Panel>("none");
  const [variantOf, setVariantOf] = useState<InlineAiAction | null>(null);
  const [ai, setAi] = useState<AiState | null>(null);
  const [aiRange, setAiRange] = useState<Range | null>(null);
  const [cardRect, setCardRect] = useState<SelectionRender["rect"] | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [askText, setAskText] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // Close any open dropdown when the selection changes to a new range.
  const selKey = render ? `${render.from}:${render.to}` : "";
  useEffect(() => {
    if (mode === "toolbar") {
      setPanel("none");
      setVariantOf(null);
    }
  }, [selKey, mode]);

  // The box the popup anchors to: the live selection (toolbar) or the frozen
  // AI-target range, re-derived on scroll/resize while the card is open.
  const anchorRect = mode === "ai" ? cardRect : (render?.rect ?? null);

  useEffect(() => {
    if (mode !== "ai" || !view || !aiRange) return;
    const recompute = (): void => {
      const a = view.coordsAtPos(aiRange.from);
      const b = view.coordsAtPos(aiRange.to);
      if (!a || !b) return;
      const left = Math.min(a.left, b.left);
      setCardRect({
        top: Math.min(a.top, b.top),
        bottom: Math.max(a.bottom, b.bottom),
        left,
        width: Math.max(a.left, b.left) - left,
      });
    };
    recompute();
    const sc = view.scrollDOM;
    sc.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    return () => {
      sc.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [mode, view, aiRange]);

  // Place the popup: measure it, center over the anchor (clamped to the
  // viewport), and choose above/below. The toolbar prefers above; the taller
  // AI card prefers below.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !anchorRect) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const center = anchorRect.left + anchorRect.width / 2;
    const left = clamp(center - w / 2, MARGIN, window.innerWidth - w - MARGIN);
    const fitsAbove = anchorRect.top > h + GAP;
    const fitsBelow = window.innerHeight - anchorRect.bottom > h + GAP;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    let below: boolean;
    if (mode === "ai") below = fitsBelow || spaceBelow >= anchorRect.top;
    else below = !fitsAbove && (fitsBelow || spaceBelow >= anchorRect.top);
    const top = below ? anchorRect.bottom + GAP : anchorRect.top - GAP - h;
    setPos({ left, top: Math.max(MARGIN, top) });
  }, [anchorRect, mode, panel, variantOf, ai?.awaitingInput, ai?.refusal, ai?.error, ai?.streaming]);

  const runCmd = useCallback(
    (cmd: (v: EditorView) => boolean) => {
      if (view) cmd(view);
    },
    [view],
  );

  const closeAi = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    if (view) setAiTargetRange(view, null);
    setAi(null);
    setAiRange(null);
    setCardRect(null);
    setMode("toolbar");
    setAskText("");
    view?.focus();
  }, [view]);

  const runStream = useCallback(
    (instruction: string, range: Range) => {
      if (!view || !aiRewrite) return;
      const selText = view.state.doc.sliceString(range.from, range.to);
      const handle = aiRewrite(inlineRewriteSystem(), inlineRewritePrompt(instruction, selText), {
        onDelta: (d) => setAi((p) => (p ? { ...p, text: p.text + d } : p)),
        onDone: (full) =>
          setAi((p) => (p ? { ...p, text: full || p.text, streaming: false } : p)),
        onError: (_k, msg) =>
          setAi((p) => (p ? { ...p, text: msg, streaming: false, error: true } : p)),
      });
      cancelRef.current = handle.cancel;
    },
    [view, aiRewrite],
  );

  // Enter the AI card for `action`. Custom actions pause on a prompt box; the
  // rest stream immediately. A Private note on a remote provider is refused.
  const startAi = useCallback(
    (action: InlineAiAction, instruction: string) => {
      if (!view) return;
      const range =
        mode === "ai" && aiRange ? aiRange : render ? { from: render.from, to: render.to } : null;
      if (!range) return;
      setPanel("none");
      setVariantOf(null);
      setAiRange(range);
      setMode("ai");
      setAiTargetRange(view, range);

      if (notePrivacyMode !== "public" && !aiIsLocal) {
        setAi({
          action,
          instruction,
          awaitingInput: false,
          text: notePrivacyMode === "local-only" ? LOCAL_ONLY_PAGE_REFUSAL : PRIVATE_PAGE_REFUSAL,
          streaming: false,
          error: false,
          refusal: true,
        });
        return;
      }
      if (action.custom && !instruction.trim()) {
        setAi({ action, instruction: "", awaitingInput: true, text: "", streaming: false, error: false, refusal: false });
        return;
      }
      setAi({ action, instruction, awaitingInput: false, text: "", streaming: true, error: false, refusal: false });
      runStream(instruction, range);
    },
    [view, mode, aiRange, render, notePrivacyMode, aiIsLocal, runStream],
  );

  const retry = useCallback(() => {
    if (!ai || !aiRange) return;
    cancelRef.current?.();
    setAi({ ...ai, text: "", streaming: true, error: false });
    runStream(ai.instruction, aiRange);
  }, [ai, aiRange, runStream]);

  const stop = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setAi((p) => (p ? { ...p, streaming: false } : p));
  }, []);

  const submitAsk = useCallback(() => {
    if (!ai || !aiRange || !askText.trim()) return;
    const instruction = askText.trim();
    setAi({ ...ai, instruction, awaitingInput: false, text: "", streaming: true });
    runStream(instruction, aiRange);
  }, [ai, aiRange, askText, runStream]);

  const replace = useCallback(() => {
    if (!view || !aiRange || !ai) return;
    view.dispatch({
      changes: { from: aiRange.from, to: aiRange.to, insert: ai.text },
      selection: { anchor: aiRange.from, head: aiRange.from + ai.text.length },
      userEvent: "input",
    });
    closeAi();
  }, [view, aiRange, ai, closeAi]);

  const insertBelow = useCallback(() => {
    if (!view || !aiRange || !ai) return;
    const at = view.state.doc.lineAt(aiRange.to).to;
    const insert = `\n\n${ai.text}`;
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      userEvent: "input",
    });
    closeAi();
  }, [view, aiRange, ai, closeAi]);

  // Escape closes the AI card (and cancels any stream) from anywhere.
  useEffect(() => {
    if (mode !== "ai") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, closeAi]);

  // Move focus into the card so keystrokes don't leak to the doc behind it.
  useEffect(() => {
    if (mode !== "ai") return;
    if (ai?.awaitingInput) askRef.current?.focus();
    else rootRef.current?.focus();
  }, [mode, ai?.awaitingInput]);

  const marks = render?.marks;
  const block = render?.block ?? "text";

  if (!view) return null;
  if (mode !== "ai" && !render) return null;

  const style: React.CSSProperties = {
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden",
  };

  // ---- AI card ----
  if (mode === "ai" && ai) {
    return (
      <div ref={rootRef} className="sel-menu sel-card" style={style} tabIndex={-1} role="dialog">
        <div className="sel-card-head">
          <AiAvatar size={18} />
          <span className="sel-card-title">{ai.action.label.replace(/…$/, "")}</span>
          {ai.streaming ? (
            <button className="sel-card-stop" onMouseDown={(e) => e.preventDefault()} onClick={stop} title="Stop">
              <Square size={13} fill="currentColor" /> Stop
            </button>
          ) : null}
        </div>

        {ai.refusal ? (
          <div className="sel-card-body">
            <div className="sel-refusal">
              <Markdown text={ai.text || PRIVATE_PAGE_REFUSAL} />
            </div>
            <div className="sel-card-foot">
              <button className="sel-btn-ghost" onClick={closeAi}>
                Close
              </button>
            </div>
          </div>
        ) : ai.awaitingInput ? (
          <div className="sel-card-body">
            <textarea
              ref={askRef}
              className="sel-ask-input"
              placeholder="Tell AI how to edit the selection…"
              value={askText}
              rows={2}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitAsk();
                }
              }}
            />
            <div className="sel-card-foot">
              <button className="sel-btn-ghost" onClick={closeAi}>
                Cancel
              </button>
              <button className="sel-btn-primary" onClick={submitAsk} disabled={!askText.trim()}>
                Generate
              </button>
            </div>
          </div>
        ) : (
          <div className="sel-card-body">
            <div className={`sel-result${ai.error ? " is-error" : ""}`}>
              {ai.text ? <Markdown text={ai.text} /> : <ThinkingDots />}
              {ai.streaming && ai.text ? <span className="sel-caret" /> : null}
            </div>
            <div className="sel-card-foot">
              <button className="sel-btn-ghost" onClick={closeAi}>
                Discard
              </button>
              <button
                className="sel-btn-ghost"
                onClick={retry}
                disabled={ai.streaming}
                title="Try again"
              >
                <RotateCcw size={13} /> Try again
              </button>
              <span className="sel-foot-spacer" />
              <button
                className="sel-btn-ghost"
                onClick={insertBelow}
                disabled={ai.streaming || !ai.text || ai.error}
                title="Insert below the selection"
              >
                <ArrowDownToLine size={13} /> Insert
              </button>
              <button
                className="sel-btn-primary"
                onClick={replace}
                disabled={ai.streaming || !ai.text || ai.error}
              >
                <Check size={13} /> Replace
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- toolbar ----
  return (
    <div
      ref={rootRef}
      className="sel-menu sel-bar"
      style={style}
      role="toolbar"
      aria-label="Text formatting"
      // Keep the editor selection intact while clicking buttons; textareas (none
      // here) would be excluded, but the bar has only buttons.
      onMouseDown={(e) => e.preventDefault()}
    >
      {panel === "turn" ? (
        <TurnPanel
          current={block}
          onPick={(b) => {
            runCmd(convertBlock(b));
            setPanel("none");
          }}
          onBack={() => setPanel("none")}
        />
      ) : panel === "skills" ? (
        <SkillsPanel
          variantOf={variantOf}
          onOpenVariants={(a) => setVariantOf(a)}
          onBack={() => (variantOf ? setVariantOf(null) : setPanel("none"))}
          onRun={(a, instruction) => startAi(a, instruction)}
        />
      ) : (
        <>
          <button
            className="sel-turn"
            onClick={() => setPanel("turn")}
            title="Turn into"
          >
            <span className="sel-turn-label">{BLOCK_LABEL[block]}</span>
            <ChevronDown size={13} />
          </button>
          <span className="sel-sep" />
          <MarkBtn icon={Bold} label="Bold" active={!!marks?.bold} onClick={() => runCmd(toggleBold)} />
          <MarkBtn icon={Italic} label="Italic" active={!!marks?.italic} onClick={() => runCmd(toggleItalic)} />
          <MarkBtn
            icon={Strikethrough}
            label="Strikethrough"
            active={!!marks?.strike}
            onClick={() => runCmd(toggleStrike)}
          />
          <MarkBtn icon={Code} label="Code" active={!!marks?.code} onClick={() => runCmd(toggleCode)} />
          <MarkBtn icon={Link} label="Link" onClick={() => runCmd(insertLink)} />
          <MarkBtn icon={Eraser} label="Clear formatting" onClick={() => runCmd(clearFormatting)} />
          <span className="sel-sep" />
          <button
            className="sel-ai"
            onClick={() => setPanel("skills")}
            title="Ask AI"
            disabled={!aiRewrite}
          >
            <Sparkles size={14} />
            <span>Ask AI</span>
            <ChevronDown size={13} />
          </button>
        </>
      )}
    </div>
  );
}

// ---- sub-components ---------------------------------------------------------

function MarkBtn({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      className={`sel-icon-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon size={16} />
    </button>
  );
}

function TurnPanel({
  current,
  onPick,
  onBack,
}: {
  current: Block;
  onPick: (b: Block) => void;
  onBack: () => void;
}): ReactNode {
  return (
    <div className="sel-panel">
      <button className="sel-panel-head" onClick={onBack}>
        <ChevronLeft size={14} /> Turn into
      </button>
      {TURN_ITEMS.map(({ block, label, icon: Icon }) => (
        <button key={block} className="sel-panel-item" onClick={() => onPick(block)}>
          <Icon size={15} className="sel-panel-ico" />
          <span>{label}</span>
          {current === block ? <Check size={14} className="sel-panel-check" /> : null}
        </button>
      ))}
    </div>
  );
}

function SkillsPanel({
  variantOf,
  onOpenVariants,
  onBack,
  onRun,
}: {
  variantOf: InlineAiAction | null;
  onOpenVariants: (a: InlineAiAction) => void;
  onBack: () => void;
  onRun: (a: InlineAiAction, instruction: string) => void;
}): ReactNode {
  if (variantOf) {
    return (
      <div className="sel-panel">
        <button className="sel-panel-head" onClick={onBack}>
          <ChevronLeft size={14} /> {variantOf.label}
        </button>
        {variantOf.variants!.map((v) => (
          <button key={v.id} className="sel-panel-item" onClick={() => onRun(variantOf, v.instruction)}>
            <span className="sel-panel-ico" />
            <span>{v.label}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="sel-panel">
      <button className="sel-panel-head" onClick={onBack}>
        <ChevronLeft size={14} /> Ask AI
      </button>
      {INLINE_AI_ACTIONS.map((a) => {
        const Icon = AI_ICON[a.icon] ?? Sparkles;
        const hasVariants = !!a.variants?.length;
        return (
          <button
            key={a.id}
            className="sel-panel-item"
            onClick={() => (hasVariants ? onOpenVariants(a) : onRun(a, a.instruction ?? ""))}
          >
            <Icon size={15} className="sel-panel-ico" />
            <span>{a.label}</span>
            {hasVariants ? <ChevronRight size={14} className="sel-panel-check" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function ThinkingDots(): ReactNode {
  return (
    <span className="ai-thinking" aria-label="Generating">
      <span />
      <span />
      <span />
    </span>
  );
}
