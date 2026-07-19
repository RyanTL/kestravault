import { describe, expect, it } from "vitest";
import { fitMenuToViewport } from "./FileExplorer";

describe("fitMenuToViewport", () => {
  it("opens a menu upward when it would run below the viewport", () => {
    expect(
      fitMenuToViewport(
        { x: 140, y: 700 },
        { width: 240, height: 300 },
        { width: 900, height: 760 },
      ),
    ).toEqual({ x: 140, y: 452 });
  });

  it("keeps a menu away from the right and top edges", () => {
    expect(
      fitMenuToViewport(
        { x: 850, y: -4 },
        { width: 240, height: 300 },
        { width: 900, height: 760 },
      ),
    ).toEqual({ x: 652, y: 8 });
  });
});
