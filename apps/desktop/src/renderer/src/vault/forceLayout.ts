// A tiny dependency-free force-directed layout for the graph view.
//
// We deliberately avoid pulling in d3-force / a graph lib: a personal vault is
// small (tens → low hundreds of notes), so a plain O(n²) repulsion pass plus
// Hooke springs along the links is fast enough and keeps the bundle lean. The
// simulation runs in "world" coordinates centred on the origin; the canvas
// renderer applies the camera (pan/zoom) on top.

export interface SimNode {
  id: string;
  name: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // When a node is being dragged it's pinned: fx/fy hold its fixed position and
  // the integrator parks it there while it still exerts forces on others.
  fx: number | null;
  fy: number | null;
}

export interface SimEdge {
  source: SimNode;
  target: SimNode;
}

export interface SimOptions {
  /** Coulomb-style repulsion strength (bigger = more spread out). */
  repulsion: number;
  /** Rest length of a link spring, in world units. */
  linkDistance: number;
  /** How stiffly links pull toward their rest length (0–1). */
  linkStrength: number;
  /** Pull toward the origin so disconnected components don't drift off. */
  gravity: number;
  /** Per-tick velocity decay (0–1). */
  damping: number;
}

const DEFAULTS: SimOptions = {
  repulsion: 5200,
  linkDistance: 64,
  linkStrength: 0.06,
  gravity: 0.028,
  damping: 0.84,
};

export class ForceSimulation {
  nodes: SimNode[];
  edges: SimEdge[];
  opts: SimOptions;
  alpha = 1;
  private alphaMin = 0.02;
  private alphaDecay = 0.02;

  constructor(nodes: SimNode[], edges: SimEdge[], opts: Partial<SimOptions> = {}) {
    this.nodes = nodes;
    this.edges = edges;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Nudge the simulation back to life after a drag or other interaction. */
  reheat(to = 0.4): void {
    this.alpha = Math.max(this.alpha, to);
  }

  /** Whether the layout has cooled to a near-rest state. */
  get settled(): boolean {
    return this.alpha < this.alphaMin;
  }

  /**
   * Advance one step. Returns `true` while the layout is still moving, `false`
   * once it has cooled — the caller can stop ticking (but keep drawing for
   * hover/selection changes) when this goes false.
   */
  tick(): boolean {
    if (this.settled) return false;
    const { nodes, edges, opts, alpha } = this;
    const n = nodes.length;

    // Repulsion — every pair pushes apart with an inverse-square falloff.
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Coincident nodes: jitter so they separate instead of dividing by ~0.
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          d2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(d2);
        const force = (opts.repulsion * alpha) / d2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Springs — each link pulls its endpoints toward the rest length.
    for (const e of edges) {
      const s = e.source;
      const t = e.target;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - opts.linkDistance) * opts.linkStrength * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    // Gravity toward the origin keeps everything (especially orphans) on screen.
    for (const node of nodes) {
      node.vx -= node.x * opts.gravity * alpha;
      node.vy -= node.y * opts.gravity * alpha;
    }

    // Integrate: pinned nodes snap to their fixed point; the rest move + cool.
    for (const node of nodes) {
      if (node.fx != null && node.fy != null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= opts.damping;
      node.vy *= opts.damping;
      node.x += node.vx;
      node.y += node.vy;
    }

    this.alpha *= 1 - this.alphaDecay;
    return !this.settled;
  }
}

/**
 * Build the simulation's node/edge objects from the graph data, seeding initial
 * positions on a jittered circle so the first few ticks fan out cleanly rather
 * than exploding from a single point.
 */
export function createSimulation(
  graphNodes: { id: string; name: string; degree: number }[],
  graphEdges: { source: string; target: string }[],
  opts?: Partial<SimOptions>,
): ForceSimulation {
  const n = graphNodes.length;
  const radius = 60 + Math.sqrt(Math.max(1, n)) * 26;
  const byId = new Map<string, SimNode>();
  const nodes: SimNode[] = graphNodes.map((g, i) => {
    // Golden-angle placement spreads the seed points evenly around the disc.
    const angle = i * 2.399963229728653;
    const r = radius * Math.sqrt((i + 0.5) / n);
    const node: SimNode = {
      id: g.id,
      name: g.name,
      degree: g.degree,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
    byId.set(g.id, node);
    return node;
  });
  const edges: SimEdge[] = [];
  for (const e of graphEdges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (source && target) edges.push({ source, target });
  }
  return new ForceSimulation(nodes, edges, opts);
}
