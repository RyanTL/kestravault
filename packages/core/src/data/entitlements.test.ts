import { describe, expect, it } from "vitest";
import type { UserEntitlement } from "../types/entitlements.js";
import {
  InMemoryEntitlementRepo,
  normalizeLifetimeCode,
  rowToUserEntitlement,
  userEntitlementToRow,
} from "./entitlements.js";

const NOW = "2026-07-03T12:00:00.000Z";
const RYAN = "00000000-0000-4000-8000-000000000001";

function entitlement(overrides: Partial<UserEntitlement> = {}): UserEntitlement {
  return {
    userId: RYAN,
    plan: "cloud",
    status: "active",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_456",
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

describe("entitlement mappers", () => {
  it("round-trips an entitlement through its row shape", () => {
    const e = entitlement();
    expect(rowToUserEntitlement(userEntitlementToRow(e))).toEqual(e);
  });
});

describe("InMemoryEntitlementRepo", () => {
  it("returns null / false for a user with no entitlement", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    expect(await repo.getForUser(RYAN)).toBeNull();
    expect(await repo.hasActivePlan(RYAN)).toBe(false);
  });

  it("an active plan within its paid period counts", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.set(entitlement());
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
    expect(await repo.getForUser(RYAN)).toEqual(entitlement());
  });

  it("a lapsed plan does not count", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.set(entitlement({ status: "lapsed" }));
    expect(await repo.hasActivePlan(RYAN)).toBe(false);
  });

  it("an 'active' row past its period end is treated as lapsed", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.set(entitlement({ currentPeriodEnd: "2026-07-01T00:00:00.000Z" }));
    expect(await repo.hasActivePlan(RYAN)).toBe(false);
  });

  it("a null period end means no expiry gate (webhook is the truth)", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.set(entitlement({ currentPeriodEnd: null }));
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
  });

  it("self-hosted instances bypass every check", async () => {
    const repo = new InMemoryEntitlementRepo(true, () => NOW);
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
    repo.set(entitlement({ status: "lapsed" }));
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
  });
});

describe("lifetime code redemption", () => {
  it("normalizes codes the way the server does", () => {
    expect(normalizeLifetimeCode(" kv-ab2c-d3ef-gh4j\n")).toBe("KV-AB2C-D3EF-GH4J");
  });

  it("grants a lifetime entitlement to the signed-in user", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.actingUserId = RYAN;
    repo.addCode("KV-AB2C-D3EF-GH4J");
    await repo.redeemLifetimeCode("kv-ab2c-d3ef-gh4j");
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
    expect(await repo.getForUser(RYAN)).toMatchObject({
      plan: "lifetime",
      status: "active",
      currentPeriodEnd: null,
    });
  });

  it("codes are single-use", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.actingUserId = RYAN;
    repo.addCode("KV-AB2C-D3EF-GH4J");
    await repo.redeemLifetimeCode("KV-AB2C-D3EF-GH4J");
    await expect(repo.redeemLifetimeCode("KV-AB2C-D3EF-GH4J")).rejects.toThrow(
      /invalid or already redeemed/,
    );
  });

  it("rejects unknown codes and signed-out callers", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    await expect(repo.redeemLifetimeCode("KV-AB2C-D3EF-GH4J")).rejects.toThrow(
      /signed-in user/,
    );
    repo.actingUserId = RYAN;
    await expect(repo.redeemLifetimeCode("KV-XXXX-XXXX-XXXX")).rejects.toThrow(
      /invalid or already redeemed/,
    );
  });

  it("redeeming replaces a lapsed subscription row with the lifetime plan", async () => {
    const repo = new InMemoryEntitlementRepo(false, () => NOW);
    repo.set(entitlement({ status: "lapsed" }));
    repo.actingUserId = RYAN;
    repo.addCode("KV-AB2C-D3EF-GH4J");
    await repo.redeemLifetimeCode("KV-AB2C-D3EF-GH4J");
    expect(await repo.hasActivePlan(RYAN)).toBe(true);
  });
});
