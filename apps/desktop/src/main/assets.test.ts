import { describe, expect, it } from "vitest";
import { assetMime, planAssetSync } from "./assets.js";

describe("planAssetSync", () => {
  it("uploads new local files and downloads new remote files", () => {
    const plan = planAssetSync({ "assets/a.png": "s1" }, { "assets/b.png": "s2" }, {});
    expect(plan.upload).toEqual(["assets/a.png"]);
    expect(plan.download).toEqual(["assets/b.png"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("leaves identical files alone", () => {
    const plan = planAssetSync(
      { "assets/a.png": "same" },
      { "assets/a.png": "same" },
      { "assets/a.png": "old" },
    );
    expect(plan).toEqual({
      upload: [],
      download: [],
      deleteRemote: [],
      deleteLocal: [],
      conflicts: [],
    });
  });

  it("propagates one-sided changes in the right direction", () => {
    const state = { "assets/a.png": "base", "assets/b.png": "base" };
    const plan = planAssetSync(
      { "assets/a.png": "edited", "assets/b.png": "base" },
      { "assets/a.png": "base", "assets/b.png": "edited" },
      state,
    );
    expect(plan.upload).toEqual(["assets/a.png"]);
    expect(plan.download).toEqual(["assets/b.png"]);
  });

  it("resolves a both-sides change as remote-wins + local conflict copy", () => {
    const plan = planAssetSync(
      { "assets/a.png": "mine" },
      { "assets/a.png": "theirs" },
      { "assets/a.png": "base" },
    );
    expect(plan.download).toEqual([]);
    expect(plan.upload).toEqual([]);
    expect(plan.conflicts).toEqual([
      { path: "assets/a.png", conflictPath: "assets/a.conflict.png" },
    ]);
  });

  it("mints unique conflict paths when the obvious one is taken", () => {
    const plan = planAssetSync(
      { "assets/a.png": "mine", "assets/a.conflict.png": "x" },
      { "assets/a.png": "theirs", "assets/a.conflict.png": "x" },
      { "assets/a.png": "base", "assets/a.conflict.png": "x" },
    );
    expect(plan.conflicts).toEqual([
      { path: "assets/a.png", conflictPath: "assets/a.conflict 2.png" },
    ]);
  });

  it("propagates deletes through the last-synced state", () => {
    // a: deleted locally (state + remote agree) -> delete remote.
    // b: deleted remotely (state + local agree) -> delete local.
    const plan = planAssetSync(
      { "assets/b.png": "base-b" },
      { "assets/a.png": "base-a" },
      { "assets/a.png": "base-a", "assets/b.png": "base-b" },
    );
    expect(plan.deleteRemote).toEqual(["assets/a.png"]);
    expect(plan.deleteLocal).toEqual(["assets/b.png"]);
  });

  it("lets edits beat deletes on both sides", () => {
    // a: locally edited, remotely deleted -> upload (edit wins).
    // b: remotely edited, locally deleted -> download (edit wins).
    const plan = planAssetSync(
      { "assets/a.png": "edited" },
      { "assets/b.png": "edited" },
      { "assets/a.png": "base", "assets/b.png": "base" },
    );
    expect(plan.upload).toEqual(["assets/a.png"]);
    expect(plan.download).toEqual(["assets/b.png"]);
    expect(plan.deleteLocal).toEqual([]);
    expect(plan.deleteRemote).toEqual([]);
  });

  it("forgets files deleted on both sides", () => {
    const plan = planAssetSync({}, {}, { "assets/a.png": "base" });
    expect(plan).toEqual({
      upload: [],
      download: [],
      deleteRemote: [],
      deleteLocal: [],
      conflicts: [],
    });
  });
});

describe("assetMime", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(assetMime("assets/pic.PNG")).toBe("image/png");
    expect(assetMime("a/b.jpeg")).toBe("image/jpeg");
    expect(assetMime("diagram.svg")).toBe("image/svg+xml");
    expect(assetMime("noext")).toBe("application/octet-stream");
  });
});
