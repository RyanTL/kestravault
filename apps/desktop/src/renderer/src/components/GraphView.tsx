import { useEffect, useMemo, useRef, useState } from "react";
import { buildGraph, type GraphData } from "@renderer/vault/graph";
import { createSimulation, type ForceSimulation, type SimNode } from "@renderer/vault/forceLayout";
import { stripFrontmatter } from "@renderer/vault/markdown";
import { ASSISTANT_PERSONA } from "@renderer/vault/aiPrompts";
import type { AiController } from "@renderer/vault/useAi";
import { Maximize, RefreshCw, X, Sparkles } from "lucide-react";

interface GraphViewProps {
  files: { name: string; path: string }[];
  activePath: string | null;
  ai: AiController;
  /** Model for the neighbourhood summary — the routed grunt tier (routing.ts). */
  summaryModel: string;
  /** Open a note in the editor (double-click a node, or the panel's Open button). */
  onOpen: (path: string) => void;
  /** Close the graph and return to the editor. */
  onClose: () => void;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Node radius in world units — scales gently with how connected a note is. */
const nodeR = (n: SimNode): number => 3 + Math.sqrt(n.degree) * 1.15;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Palette {
  edge: string;
  edgeLit: string;
  node: string;
  dim: string;
  lit: string;
  focus: string;
  label: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const g = (k: string, fallback: string): string => s.getPropertyValue(k).trim() || fallback;
  return {
    edge: g("--border", "#2e2e2e"),
    edgeLit: g("--text-dim", "#9c9c9c"),
    node: g("--text-faint", "#6e6e6e"),
    dim: g("--accent-dim", "#4a4a4a"),
    lit: g("--text-dim", "#9c9c9c"),
    focus: g("--accent", "#ffffff"),
    label: g("--text-dim", "#9c9c9c"),
  };
}

export function GraphView({ files, activePath, ai, summaryModel, onOpen, onClose }: GraphViewProps) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(activePath);
  const [rebuildToken, setRebuildToken] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ForceSimulation | null>(null);
  const nodeIndexRef = useRef<Map<string, SimNode>>(new Map());
  const graphRef = useRef<GraphData | null>(null);
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const paletteRef = useRef<Palette>(readPalette());
  const rafRef = useRef(0);
  const dirtyRef = useRef(true);
  const fitInitialRef = useRef(false);
  const fitSettledRef = useRef(false);

  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;

  // Pointer interaction state (refs so the rAF loop and handlers don't restart).
  const dragRef = useRef<SimNode | null>(null);
  const panRef = useRef<{ px: number; py: number; camX: number; camY: number } | null>(null);
  const movedRef = useRef(false);

  // ── Build (and rebuild) the graph + simulation ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const data = await buildGraph(files);
      if (cancelled) return;
      const sim = createSimulation(data.nodes, data.edges);
      simRef.current = sim;
      graphRef.current = data;
      nodeIndexRef.current = new Map(sim.nodes.map((n) => [n.id, n]));
      fitInitialRef.current = false;
      fitSettledRef.current = false;
      dirtyRef.current = true;
      setGraph(data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [files, rebuildToken]);

  // ── Canvas sizing, render loop, and physics ───────────────────────────────
  useEffect(() => {
    paletteRef.current = readPalette();

    const syncSize = (): void => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      dirtyRef.current = true;
    };

    syncSize();
    const ro = new ResizeObserver(syncSize);
    if (wrapRef.current) ro.observe(wrapRef.current);

    // Re-read the monochrome palette when the theme flips (data-theme on <html>),
    // then mark dirty so the next frame repaints in the new colours.
    const themeObs = new MutationObserver(() => {
      paletteRef.current = readPalette();
      dirtyRef.current = true;
    });
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const frame = (): void => {
      const sim = simRef.current;
      const { w } = sizeRef.current;
      if (sim && w > 0) {
        if (!fitInitialRef.current) {
          fitView();
          fitInitialRef.current = true;
        }
        const active = sim.tick();
        if (sim.settled && !fitSettledRef.current) {
          fitView();
          fitSettledRef.current = true;
        }
        if (active || dirtyRef.current) {
          draw();
          dirtyRef.current = false;
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      themeObs.disconnect();
    };
    // Mount-only: the loop reads all live state through refs, so it never restarts.
  }, []);

  /** Frame the whole graph in the viewport. */
  function fitView(): void {
    const sim = simRef.current;
    const { w, h } = sizeRef.current;
    const cam = camRef.current;
    if (!sim || sim.nodes.length === 0 || w === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of sim.nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 90;
    const gw = Math.max(maxX - minX, 1);
    const gh = Math.max(maxY - minY, 1);
    const scale = clamp(Math.min((w - pad * 2) / gw, (h - pad * 2) / gh), 0.05, 2.2);
    cam.scale = scale;
    cam.x = w / 2 - ((minX + maxX) / 2) * scale;
    cam.y = h / 2 - ((minY + maxY) / 2) * scale;
    dirtyRef.current = true;
  }

  /** Set of node ids lit when `focus` is active: the focus + its neighbours. */
  function litSet(focus: string): Set<string> {
    const s = new Set<string>([focus]);
    const nb = graphRef.current?.neighbors.get(focus);
    if (nb) for (const id of nb) s.add(id);
    return s;
  }

  function draw(): void {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const cam = camRef.current;
    const col = paletteRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const focus = hoverRef.current ?? selectedRef.current;
    const lit = focus ? litSet(focus) : null;

    // Edges.
    for (const e of sim.edges) {
      const sx = e.source.x * cam.scale + cam.x;
      const sy = e.source.y * cam.scale + cam.y;
      const tx = e.target.x * cam.scale + cam.x;
      const ty = e.target.y * cam.scale + cam.y;
      if (focus) {
        const on = e.source.id === focus || e.target.id === focus;
        ctx.globalAlpha = on ? 0.85 : 0.07;
        ctx.strokeStyle = on ? col.edgeLit : col.edge;
        ctx.lineWidth = on ? 1.4 : 0.7;
      } else {
        ctx.globalAlpha = 0.34;
        ctx.strokeStyle = col.edge;
        ctx.lineWidth = 0.8;
      }
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // Nodes + labels.
    const showLabels = cam.scale > 0.5;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `11px ${FONT}`;
    for (const n of sim.nodes) {
      const sx = n.x * cam.scale + cam.x;
      const sy = n.y * cam.scale + cam.y;
      const r = Math.max(nodeR(n) * cam.scale, 1.4);
      const isFocus = n.id === focus;
      const isLit = lit?.has(n.id) ?? false;

      if (focus) {
        ctx.globalAlpha = isFocus || isLit ? 1 : 0.32;
        ctx.fillStyle = isFocus ? col.focus : isLit ? col.lit : col.dim;
      } else {
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = col.node;
      }
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      // "You are here" ring for the currently-open note.
      if (n.id === activePathRef.current && n.id !== selectedRef.current) {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = col.lit;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Selection ring.
      if (n.id === selectedRef.current) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.focus;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      const labelled = showLabels || isFocus || isLit || n.id === activePathRef.current;
      if (labelled) {
        ctx.globalAlpha = focus ? (isFocus || isLit ? 0.95 : 0.16) : 0.72;
        ctx.fillStyle = isFocus ? col.focus : col.label;
        ctx.fillText(n.name, sx, sy + r + 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Hit testing + pointer interaction ─────────────────────────────────────
  function nodeAt(px: number, py: number): SimNode | null {
    const sim = simRef.current;
    const cam = camRef.current;
    if (!sim) return null;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of sim.nodes) {
      const sx = n.x * cam.scale + cam.x;
      const sy = n.y * cam.scale + cam.y;
      const r = Math.max(nodeR(n) * cam.scale, 1.4) + 4;
      const dx = px - sx;
      const dy = py - sy;
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function localPoint(e: { clientX: number; clientY: number }): { px: number; py: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent): void {
    canvasRef.current?.setPointerCapture(e.pointerId);
    movedRef.current = false;
    const { px, py } = localPoint(e);
    const hit = nodeAt(px, py);
    if (hit) {
      hit.fx = hit.x;
      hit.fy = hit.y;
      dragRef.current = hit;
      simRef.current?.reheat(0.3);
    } else {
      const cam = camRef.current;
      panRef.current = { px, py, camX: cam.x, camY: cam.y };
    }
  }

  function onPointerMove(e: React.PointerEvent): void {
    const { px, py } = localPoint(e);
    const cam = camRef.current;
    if (dragRef.current) {
      const node = dragRef.current;
      node.fx = (px - cam.x) / cam.scale;
      node.fy = (py - cam.y) / cam.scale;
      movedRef.current = true;
      simRef.current?.reheat(0.25);
      dirtyRef.current = true;
    } else if (panRef.current) {
      const p = panRef.current;
      cam.x = p.camX + (px - p.px);
      cam.y = p.camY + (py - p.py);
      if (Math.abs(px - p.px) + Math.abs(py - p.py) > 3) movedRef.current = true;
      dirtyRef.current = true;
    } else {
      const hit = nodeAt(px, py);
      const id = hit?.id ?? null;
      if (id !== hoverRef.current) {
        hoverRef.current = id;
        dirtyRef.current = true;
      }
      if (canvasRef.current) canvasRef.current.style.cursor = hit ? "pointer" : "grab";
    }
  }

  function onPointerUp(e: React.PointerEvent): void {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    const node = dragRef.current;
    if (node) {
      if (!movedRef.current) {
        // A click (not a drag): select + let it rejoin the layout.
        node.fx = null;
        node.fy = null;
        setSelected(node.id);
      }
      // A real drag leaves the node pinned where it was dropped.
    } else if (panRef.current && !movedRef.current) {
      // Click on empty space clears the selection.
      setSelected(null);
    }
    dragRef.current = null;
    panRef.current = null;
  }

  function onDoubleClick(e: React.MouseEvent): void {
    const { px, py } = localPoint(e);
    const hit = nodeAt(px, py);
    if (hit) onOpen(hit.id);
    else fitView();
  }

  // Native non-passive wheel listener so we can preventDefault on zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cam = camRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = clamp(cam.scale * factor, 0.05, 4);
      const wx = (px - cam.x) / cam.scale;
      const wy = (py - cam.y) / cam.scale;
      cam.x = px - wx * scale;
      cam.y = py - wy * scale;
      cam.scale = scale;
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  /** Select a node and recentre the camera on it (used by the neighbour list). */
  function focusNode(id: string): void {
    const node = nodeIndexRef.current.get(id);
    if (node) {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      cam.x = w / 2 - node.x * cam.scale;
      cam.y = h / 2 - node.y * cam.scale;
      dirtyRef.current = true;
    }
    setSelected(id);
  }

  // ── Derived data for the side panel ───────────────────────────────────────
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of graph?.nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [graph]);

  const selectedInfo = useMemo(() => {
    if (!graph || !selected) return null;
    const node = graph.nodes.find((n) => n.id === selected);
    if (!node) return null;
    const neighbors = [...(graph.neighbors.get(selected) ?? [])]
      .map((id) => ({ path: id, name: nameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: node.id, name: node.name, neighbors };
  }, [graph, selected, nameById]);

  const stats = graph ? { notes: graph.nodes.length, links: graph.edges.length } : null;

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <span className="graph-title">Graph</span>
        {stats ? (
          <span className="graph-meta">
            {stats.notes} {stats.notes === 1 ? "note" : "notes"} · {stats.links}{" "}
            {stats.links === 1 ? "link" : "links"}
          </span>
        ) : null}
        <span className="graph-toolbar-spacer" />
        <button className="graph-tool-btn" title="Fit to view" onClick={() => fitView()}>
          <FitIcon />
        </button>
        <button
          className="graph-tool-btn"
          title="Rebuild graph"
          onClick={() => setRebuildToken((t) => t + 1)}
        >
          <RefreshIcon />
        </button>
        <button className="graph-tool-btn" title="Close graph" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="graph-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
        />

        {loading ? <div className="graph-overlay-msg">Building graph…</div> : null}
        {!loading && graph && graph.nodes.length === 0 ? (
          <div className="graph-overlay-msg">No notes yet. Create one to see it here.</div>
        ) : null}

        {selectedInfo ? (
          <NeighborhoodPanel
            key={selectedInfo.path}
            node={selectedInfo}
            ai={ai}
            summaryModel={summaryModel}
            onOpen={onOpen}
            onSelectNeighbor={focusNode}
            onClose={() => setSelected(null)}
          />
        ) : null}

        {!loading && graph && graph.nodes.length > 0 ? (
          <div className="graph-hint">
            Drag to pan · scroll to zoom · click a note to focus · double-click to open
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── AI neighbourhood summary panel ──────────────────────────────────────────

const NEIGHBORHOOD_INSTRUCTION = [
  "The user selected a note in their knowledge graph.",
  "In 3–6 short bullet points, explain the common thread linking this note to the ones connected to it,",
  "surface anything notable, and suggest one connection or note that seems missing.",
  "Cite note titles in **bold**. Keep it under 130 words. No preamble.",
].join(" ");

interface PanelNode {
  path: string;
  name: string;
  neighbors: { path: string; name: string }[];
}

async function readSafe(path: string): Promise<string> {
  try {
    return await window.api.vault.read(path);
  } catch {
    return "";
  }
}

/** Render a single line with `**bold**` spans (no HTML injection). */
function renderInline(text: string): React.ReactNode {
  return text.split(/\*\*/).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
  );
}

function NeighborhoodPanel({
  node,
  ai,
  summaryModel,
  onOpen,
  onSelectNeighbor,
  onClose,
}: {
  node: PanelNode;
  ai: AiController;
  summaryModel: string;
  onOpen: (path: string) => void;
  onSelectNeighbor: (path: string) => void;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // Cancel any in-flight stream if the selected node changes / panel unmounts.
  useEffect(() => () => cancelRef.current?.(), []);

  async function summarize(): Promise<void> {
    setBusy(true);
    setSummary("");
    setError(null);
    const focusBody = stripFrontmatter(await readSafe(node.path)).trim().slice(0, 1600);
    const picked = node.neighbors.slice(0, 8);
    const parts = await Promise.all(
      picked.map(async (nb) => {
        const body = stripFrontmatter(await readSafe(nb.path)).trim().slice(0, 500);
        return `### ${nb.name}\n${body || "(empty note)"}`;
      }),
    );
    const user =
      `Focus note: "${node.name}"\n"""\n${focusBody || "(empty note)"}\n"""\n\n` +
      (picked.length
        ? `Notes linked to it:\n\n${parts.join("\n\n")}`
        : "This note has no links to other notes yet.");
    const system = `${ASSISTANT_PERSONA} ${NEIGHBORHOOD_INSTRUCTION}`;
    const { cancel } = ai.stream(system, [{ role: "user", content: user }], summaryModel, {
      onDelta: (t) => setSummary((s) => s + t),
      onDone: () => setBusy(false),
      onError: (_kind, message) => {
        setBusy(false);
        setError(message);
      },
    });
    cancelRef.current = cancel;
  }

  return (
    <div className="graph-panel">
      <div className="graph-panel-head">
        <span className="graph-panel-title" title={node.path}>
          {node.name}
        </span>
        <button className="graph-panel-x" title="Close" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="graph-panel-actions">
        <button className="graph-panel-open" onClick={() => onOpen(node.path)}>
          Open note
        </button>
        {busy ? (
          <button className="graph-panel-ai" onClick={() => cancelRef.current?.()}>
            Stop
          </button>
        ) : (
          <button className="graph-panel-ai" onClick={() => void summarize()}>
            <SparkleIcon /> Summarize neighborhood
          </button>
        )}
      </div>

      {error ? <p className="graph-panel-error">{error}</p> : null}

      {summary ? (
        <div className="graph-summary">
          {summary.split("\n").map((line, i) =>
            line.trim() ? <p key={i}>{renderInline(line)}</p> : null,
          )}
          {busy ? <span className="graph-caret" /> : null}
        </div>
      ) : null}

      <div className="graph-panel-section">
        {node.neighbors.length === 0 ? "No links yet" : `Linked notes · ${node.neighbors.length}`}
      </div>
      <ul className="graph-neighbors">
        {node.neighbors.map((nb) => (
          <li key={nb.path}>
            <button
              className="graph-neighbor"
              title={nb.path}
              onClick={() => onSelectNeighbor(nb.path)}
              onDoubleClick={() => onOpen(nb.path)}
            >
              {nb.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function FitIcon() {
  return <Maximize size={15} strokeWidth={1.6} aria-hidden />;
}

function RefreshIcon() {
  return <RefreshCw size={15} strokeWidth={1.6} aria-hidden />;
}

function CloseIcon({ size = 15 }: { size?: number }) {
  return <X size={size} strokeWidth={1.6} aria-hidden />;
}

function SparkleIcon() {
  return <Sparkles size={13} aria-hidden />;
}
