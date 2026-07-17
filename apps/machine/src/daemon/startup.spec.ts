import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { describe, expect, it } from "vitest";

import type { TransactionSnapshot } from "./schemas";

import { routeForBootFailure, routeForStartup } from "./startup";

function configuration(claimed: boolean): EffectiveMachineRuntimeConfiguration {
  return {
    sourceDocuments: { profileCache: claimed ? {} : null },
    machine: claimed ? { code: "MACHINE-001" } : null,
    profileRefresh: { status: claimed ? "accepted" : "unclaimed" },
  } as unknown as EffectiveMachineRuntimeConfiguration;
}

function transaction(
  nextAction: TransactionSnapshot["nextAction"],
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440001",
    orderNo: "ORD-STARTUP-001",
    productSummary: null,
    paymentId: null,
    paymentNo: null,
    paymentMethod: nextAction === "wait_payment" ? "qr_code" : null,
    paymentProvider: nextAction === "wait_payment" ? "alipay" : null,
    paymentUrl:
      nextAction === "wait_payment" ? "https://pay.example/order" : null,
    paymentStatus: nextAction === "wait_payment" ? "pending" : null,
    orderStatus: nextAction === "wait_payment" ? "pending_payment" : null,
    totalAmountCents: nextAction === "wait_payment" ? 1200 : null,
    vending: null,
    nextAction,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
  } as TransactionSnapshot;
}

describe("routeForStartup", () => {
  it("keeps an unclaimed bootstrap in Local Operations", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: configuration(false),
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("keeps a positively known unclaimed lifecycle in Local Operations during an outage", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        effectiveRuntimeConfiguration: configuration(false),
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("uses the accepted provisioning profile as catalog authority even when refresh is degraded", () => {
    const claimedWithDegradedRefresh = {
      ...configuration(true),
      profileRefresh: {
        status: "degraded" as const,
        lastError: "profile refresh unavailable",
      },
    } as EffectiveMachineRuntimeConfiguration;

    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: claimedWithDegradedRefresh,
        restoredTransaction: null,
      }),
    ).toBe("/catalog");
  });

  it("keeps an unknown runtime snapshot on the customer offline surface", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: null,
        restoredTransaction: null,
      }),
    ).toBe("/offline");
  });

  it("keeps a degraded runtime snapshot without identity on the customer offline surface", () => {
    const degradedWithoutIdentity = {
      ...configuration(false),
      profileRefresh: {
        status: "degraded" as const,
        lastError: "profile refresh unavailable",
      },
    } as EffectiveMachineRuntimeConfiguration;

    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: degradedWithoutIdentity,
        restoredTransaction: null,
      }),
    ).toBe("/offline");
  });

  it("keeps an unclaimed status with a cached profile on the customer offline surface", () => {
    const inconsistentUnclaimedProfile = {
      ...configuration(false),
      sourceDocuments: { profileCache: {} },
    } as unknown as EffectiveMachineRuntimeConfiguration;

    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: inconsistentUnclaimedProfile,
        restoredTransaction: null,
      }),
    ).toBe("/offline");
  });

  it("keeps partial claimed identity observations on the customer offline surface", () => {
    const missingMachine = {
      ...configuration(true),
      machine: null,
    } as EffectiveMachineRuntimeConfiguration;
    const missingProfileCache = {
      ...configuration(true),
      sourceDocuments: { profileCache: null },
    } as unknown as EffectiveMachineRuntimeConfiguration;

    for (const effectiveRuntimeConfiguration of [
      missingMachine,
      missingProfileCache,
    ]) {
      expect(
        routeForStartup({
          daemonAvailable: true,
          effectiveRuntimeConfiguration,
          restoredTransaction: null,
        }),
      ).toBe("/offline");
    }
  });

  it("keeps recovered payment navigation ahead of an unclaimed configuration", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: configuration(false),
        restoredTransaction: transaction("wait_payment"),
      }),
    ).toBe("/payment");
  });

  it("keeps recovered payment navigation ahead of an unknown daemon outage", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        effectiveRuntimeConfiguration: null,
        restoredTransaction: transaction("wait_payment"),
      }),
    ).toBe("/payment");
  });

  it("keeps recovered dispensing and terminal navigation ahead of configuration routing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: configuration(false),
        restoredTransaction: transaction("dispensing"),
      }),
    ).toBe("/dispensing");

    expect(
      routeForStartup({
        daemonAvailable: true,
        effectiveRuntimeConfiguration: configuration(false),
        restoredTransaction: transaction("manual_handling"),
      }),
    ).toMatchObject({ name: "result", params: { kind: "manual_handling" } });
  });

  it("keeps each terminal customer result ahead of Local Operations", () => {
    const terminalCases = [
      "success",
      "payment_failed",
      "closed",
      "refund_pending",
    ] as const;
    for (const nextAction of terminalCases) {
      expect(
        routeForStartup({
          daemonAvailable: true,
          effectiveRuntimeConfiguration: configuration(false),
          restoredTransaction: transaction(nextAction),
        }),
      ).toMatchObject({ name: "result", params: { kind: nextAction } });
    }
  });

  it("keeps a claimed machine on the customer offline surface when daemon IPC is unavailable", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        effectiveRuntimeConfiguration: configuration(true),
        restoredTransaction: null,
      }),
    ).toBe("/offline");
  });

  it("keeps a fresh unknown daemon outage on the customer offline surface", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        effectiveRuntimeConfiguration: null,
        restoredTransaction: null,
      }),
    ).toBe("/offline");
  });

  it("preserves a recovered transaction if an ordinary boot read fails", () => {
    expect(routeForBootFailure(transaction("wait_payment"))).toBe("/payment");
    expect(routeForBootFailure(null)).toBe("/offline");
    expect(routeForBootFailure(null, configuration(true))).toBe("/offline");
  });
});
