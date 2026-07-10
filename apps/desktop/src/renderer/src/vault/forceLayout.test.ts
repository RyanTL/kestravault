import { describe, expect, it } from "vitest";
import { createSimulation, ForceSimulation } from "@renderer/vault/forceLayout";

const graphNodes = [
  { id: "a", name: "A", degree: 1 },
  { id: "b", name: "B", degree: 1 },
];
const graphEdges = [{ source: "a", target: "b" }];

describe("createSimulation", () => {
  it("seeds finite starting positions for every node", () => {
    const sim = createSimulation(graphNodes, graphEdges);
    expect(sim.nodes).toHaveLength(2);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("only builds edges whose endpoints both exist", () => {
    const sim = createSimulation(graphNodes, [
      { source: "a", target: "b" },
      { source: "a", target: "missing" },
    ]);
    expect(sim.edges).toHaveLength(1);
    expect(sim.edges[0]?.source.id).toBe("a");
    expect(sim.edges[0]?.target.id).toBe("b");
  });

  it("produces no NaNs on an empty graph", () => {
    const sim = createSimulation([], []);
    expect(sim.nodes).toEqual([]);
    expect(sim.tick()).toBe(true); // one live tick, then it cools
  });
});

describe("ForceSimulation", () => {
  it("cools to a settled state after enough ticks", () => {
    const sim = createSimulation(graphNodes, graphEdges);
    let ticks = 0;
    while (sim.tick() && ticks < 1000) ticks++;
    expect(sim.settled).toBe(true);
    expect(ticks).toBeLessThan(1000);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("separates coincident nodes instead of producing NaN", () => {
    const sim = new ForceSimulation(
      [
        { id: "a", name: "A", degree: 0, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null },
        { id: "b", name: "B", degree: 0, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null },
      ],
      [],
    );
    sim.tick();
    for (const n of sim.nodes) {
      expect(Number.isNaN(n.x)).toBe(false);
      expect(Number.isNaN(n.y)).toBe(false);
    }
  });

  it("pins a node fixed at its fx/fy while dragging", () => {
    const sim = createSimulation(graphNodes, graphEdges);
    const a = sim.nodes[0]!;
    a.fx = 123;
    a.fy = -45;
    sim.tick();
    expect(a.x).toBe(123);
    expect(a.y).toBe(-45);
  });

  it("reheat raises alpha to revive a settled layout", () => {
    const sim = createSimulation(graphNodes, graphEdges);
    while (sim.tick());
    expect(sim.settled).toBe(true);
    sim.reheat(0.5);
    expect(sim.settled).toBe(false);
  });
});
