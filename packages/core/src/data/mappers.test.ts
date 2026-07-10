import { describe, expect, it } from "vitest";
import type { FileRecord, Workspace } from "../types/entities.js";
import type { PrivacyRuleRecord } from "../privacy/index.js";
import {
  fileToRow,
  privacyRuleToRow,
  rowToFile,
  rowToPrivacyRule,
  rowToWorkspace,
  workspaceToRow,
} from "./mappers.js";
import { InMemoryPrivacyRuleRepo } from "./in-memory.js";

describe("mappers", () => {
  it("round-trips a file entity through its row shape", () => {
    const file: FileRecord = {
      id: "f-1",
      workspaceId: "ws-1",
      path: "wiki/concepts/ownership.md",
      zone: "wiki",
      type: "concept",
      title: "Ownership",
      content: "# Ownership",
      sha256: "abc",
      version: 3,
      updatedBy: "agent",
      updatedAt: "2026-06-27T12:00:00.000Z",
      deleted: false,
    };
    expect(rowToFile(fileToRow(file))).toEqual(file);
  });

  it("maps workspace columns to camelCase and back", () => {
    const ws: Workspace = {
      id: "ws-1",
      ownerId: "owner-1",
      name: "Brain",
      createdAt: "2026-06-27T12:00:00.000Z",
      config: { ingestMode: "realtime", runMode: "deep", scaffold: ["entities"] },
    };
    const row = workspaceToRow(ws);
    expect(row.owner_id).toBe("owner-1");
    expect(rowToWorkspace(row)).toEqual(ws);
  });

  it("falls back to default config when the row's config jsonb is empty", () => {
    const ws = rowToWorkspace({
      id: "ws-1",
      owner_id: "owner-1",
      name: "Brain",
      created_at: "2026-06-27T12:00:00.000Z",
      config: {},
    });
    expect(ws.config).toEqual({
      ingestMode: "async",
      runMode: "default",
      scaffold: ["entities", "concepts", "topics", "sources"],
    });
  });

  it("round-trips a privacy rule through its row shape and in-memory repo", async () => {
    const rule: PrivacyRuleRecord = {
      workspaceId: "ws-1",
      path: "notes/private",
      target: "folder",
      mode: "cloud-ai-private",
      updatedBy: "00000000-0000-4000-8000-00000000000a",
      updatedAt: "2026-07-09T12:00:00.000Z",
      deleted: false,
      source: "cloud",
    };
    expect(rowToPrivacyRule(privacyRuleToRow(rule))).toEqual(rule);

    const repo = new InMemoryPrivacyRuleRepo();
    await repo.upsert(rule);
    expect(await repo.list("ws-1")).toEqual([rule]);
  });
});
