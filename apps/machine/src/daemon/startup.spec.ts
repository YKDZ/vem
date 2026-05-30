import { describe, expect, it } from "vitest";

import { routeForStartup } from "./startup";

describe("routeForStartup", () => {
  const healthBase = {
    status: "healthy" as const,
    process: {
      component: "daemon",
      level: "info",
      code: "ok",
      message: "ok",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 100,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  it("routes offline when daemon unavailable", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        health: null,
        ready: null,
        transaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes maintenance when config missing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase, configConfigured: false },
        ready: null,
        transaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes payment", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        ready: null,
        transaction: {
          orderId: "o",
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "submit_payment",
          maskedAuthCode: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toBe("/payment");
  });

  it("routes dispensing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        ready: null,
        transaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "dispensing",
          maskedAuthCode: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toBe("/dispensing");
  });

  it("routes result", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "success",
          maskedAuthCode: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toMatchObject({ name: "result", params: { kind: "success" } });
  });

  it("routes offline based on ready snapshot", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase },
        ready: {
          ready: true,
          canSell: false,
          mode: "daemon",
          blockingCodes: ["mqtt"],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "offline",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/offline");
  });

  it("routes catalog by default when sell available", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/catalog");
  });
});
