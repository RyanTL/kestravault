import { describe, expect, it } from "vitest";
import type { WorkspaceInvite, WorkspaceMember } from "../types/members.js";
import { WORKSPACE_MEMBER_CAP } from "../types/members.js";
import { InMemoryFileRepo, InMemoryMembershipRepo } from "./in-memory.js";
import {
  rowToWorkspaceInvite,
  rowToWorkspaceMember,
  workspaceInviteToRow,
  workspaceMemberToRow,
} from "./mappers.js";

const NOW = "2026-07-03T12:00:00.000Z";
const LATER = "2026-07-10T12:00:00.000Z";
const EARLIER = "2026-07-01T12:00:00.000Z";

function member(overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    workspaceId: "ws-1",
    userId: "user-owner",
    role: "owner",
    createdAt: NOW,
    ...overrides,
  };
}

function invite(overrides: Partial<WorkspaceInvite> = {}): WorkspaceInvite {
  return {
    id: "inv-1",
    token: "tok-secret-1",
    workspaceId: "ws-1",
    invitedEmail: null,
    expiresAt: LATER,
    redeemedBy: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** A repo with a fixed clock and the workspace owner already enrolled. */
async function repoWithOwner(): Promise<InMemoryMembershipRepo> {
  const repo = new InMemoryMembershipRepo(() => NOW);
  await repo.addMember(member());
  return repo;
}

describe("InMemoryMembershipRepo — member cap", () => {
  it("accepts the owner plus 3 members (4 people total)", async () => {
    const repo = await repoWithOwner();
    for (let i = 1; i <= WORKSPACE_MEMBER_CAP; i++) {
      await repo.addMember(member({ userId: `user-${i}`, role: "member" }));
    }
    expect(await repo.listMembers("ws-1")).toHaveLength(4);
  });

  it("rejects the 4th member", async () => {
    const repo = await repoWithOwner();
    for (let i = 1; i <= WORKSPACE_MEMBER_CAP; i++) {
      await repo.addMember(member({ userId: `user-${i}`, role: "member" }));
    }
    await expect(
      repo.addMember(member({ userId: "user-4", role: "member" })),
    ).rejects.toThrow(/member cap exceeded/);
  });

  it("the owner does not count toward the cap, and only one owner is allowed", async () => {
    const repo = await repoWithOwner();
    // Cap counts 'member' rows only — 3 members fit alongside the owner...
    for (let i = 1; i <= WORKSPACE_MEMBER_CAP; i++) {
      await repo.addMember(member({ userId: `user-${i}`, role: "member" }));
    }
    // ...and a second 'owner' row is rejected regardless.
    await expect(
      repo.addMember(member({ userId: "user-owner-2", role: "owner" })),
    ).rejects.toThrow(/already has an owner/);
  });

  it("rejects a duplicate membership and scopes the cap per workspace", async () => {
    const repo = await repoWithOwner();
    await repo.addMember(member({ userId: "user-1", role: "member" }));
    await expect(
      repo.addMember(member({ userId: "user-1", role: "member" })),
    ).rejects.toThrow(/already a member/);
    // A different workspace has its own roster and its own cap.
    await repo.addMember(member({ workspaceId: "ws-2", role: "owner" }));
    expect(await repo.listMembers("ws-2")).toHaveLength(1);
  });
});

describe("InMemoryMembershipRepo — invites", () => {
  it("redeems an invite exactly once", async () => {
    const repo = await repoWithOwner();
    await repo.createInvite(invite());

    const redeemed = await repo.redeemInvite("tok-secret-1", "user-1");
    expect(redeemed).toMatchObject({
      workspaceId: "ws-1",
      userId: "user-1",
      role: "member",
    });
    expect(await repo.checkAccess("ws-1", "user-1")).toBe(true);

    await expect(repo.redeemInvite("tok-secret-1", "user-2")).rejects.toThrow(
      /already redeemed/,
    );
    expect(await repo.checkAccess("ws-1", "user-2")).toBe(false);
  });

  it("rejects an expired invite", async () => {
    const repo = await repoWithOwner();
    await repo.createInvite(invite({ expiresAt: EARLIER }));
    await expect(repo.redeemInvite("tok-secret-1", "user-1")).rejects.toThrow(
      /expired/,
    );
    expect(await repo.checkAccess("ws-1", "user-1")).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const repo = await repoWithOwner();
    await expect(repo.redeemInvite("tok-nope", "user-1")).rejects.toThrow(
      /invalid invite token/,
    );
  });

  it("does not burn the token when the workspace is full", async () => {
    const repo = await repoWithOwner();
    for (let i = 1; i <= WORKSPACE_MEMBER_CAP; i++) {
      await repo.addMember(member({ userId: `user-${i}`, role: "member" }));
    }
    await repo.createInvite(invite());

    await expect(repo.redeemInvite("tok-secret-1", "user-4")).rejects.toThrow(
      /member cap exceeded/,
    );
    // The failed redemption must not consume the single use — after a member
    // is removed (out of scope here), the invite would still be redeemable.
    await expect(repo.redeemInvite("tok-secret-1", "user-5")).rejects.toThrow(
      /member cap exceeded/,
    );
  });
});

describe("InMemoryMembershipRepo — access checks", () => {
  it("denies a non-member and grants owner and members alike", async () => {
    const repo = await repoWithOwner();
    await repo.addMember(member({ userId: "user-1", role: "member" }));

    expect(await repo.checkAccess("ws-1", "user-owner")).toBe(true);
    expect(await repo.checkAccess("ws-1", "user-1")).toBe(true);
    expect(await repo.checkAccess("ws-1", "user-stranger")).toBe(false);
    expect(await repo.checkAccess("ws-unknown", "user-owner")).toBe(false);
  });
});

describe("InMemoryMembershipRepo — member directory", () => {
  it("resolves member ids to emails, null when the account has none", async () => {
    const repo = await repoWithOwner();
    await repo.addMember(member({ userId: "user-1", role: "member" }));
    repo.setEmail("user-owner", "ryan@example.com");

    const directory = await repo.memberDirectory("ws-1");
    expect(directory).toContainEqual({ userId: "user-owner", email: "ryan@example.com" });
    expect(directory).toContainEqual({ userId: "user-1", email: null });
    expect(await repo.memberDirectory("ws-unknown")).toEqual([]);
  });
});

describe("InMemoryMembershipRepo — change feed", () => {
  it("returns versions newest-first with author emails and file context", async () => {
    const files = new InMemoryFileRepo();
    const repo = new InMemoryMembershipRepo(() => NOW, files);
    repo.setEmail("user-1", "alice@example.com");

    const base = {
      workspaceId: "ws-1",
      zone: "notes" as const,
      type: "note" as const,
      updatedBy: "human" as const,
      deleted: false,
    };
    await files.commit(
      {
        ...base,
        id: "f-1",
        path: "notes/a.md",
        title: "A",
        content: "one",
        sha256: "s1",
        version: 1,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      { versionId: "v-1", expectedVersion: 0, authorId: "user-1" },
    );
    await files.commit(
      {
        ...base,
        id: "f-1",
        path: "notes/a.md",
        title: "A",
        content: "two",
        sha256: "s2",
        version: 2,
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      { versionId: "v-2", expectedVersion: 1, authorId: null },
    );

    const feed = await repo.changeFeed("ws-1");
    expect(feed.map((e) => e.versionId)).toEqual(["v-2", "v-1"]);
    expect(feed[0]).toMatchObject({
      path: "notes/a.md",
      version: 2,
      authorId: null,
      authorEmail: null,
    });
    expect(feed[1]).toMatchObject({ authorId: "user-1", authorEmail: "alice@example.com" });

    // Limit is honored (and the repo without a file source yields nothing).
    expect(await repo.changeFeed("ws-1", 1)).toHaveLength(1);
    expect(await new InMemoryMembershipRepo().changeFeed("ws-1")).toEqual([]);
  });
});

describe("membership mappers", () => {
  it("round-trips a workspace member through its row shape", () => {
    const m = member({ userId: "user-1", role: "member" });
    const row = workspaceMemberToRow(m);
    expect(row.workspace_id).toBe("ws-1");
    expect(row.user_id).toBe("user-1");
    expect(rowToWorkspaceMember(row)).toEqual(m);
  });

  it("round-trips an invite, preserving nullable email and redeemed_by", () => {
    const open = invite();
    expect(rowToWorkspaceInvite(workspaceInviteToRow(open))).toEqual(open);

    const targeted = invite({
      invitedEmail: "friend@example.com",
      redeemedBy: "user-1",
    });
    const row = workspaceInviteToRow(targeted);
    expect(row.invited_email).toBe("friend@example.com");
    expect(row.redeemed_by).toBe("user-1");
    expect(rowToWorkspaceInvite(row)).toEqual(targeted);
  });
});
