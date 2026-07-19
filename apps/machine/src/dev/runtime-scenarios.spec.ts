import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { machineRoutes } from "@/router/routes";

import {
  getMachineRuntimeScenario,
  machineRuntimeScenarios,
  selectScreenshotMachineRuntimeScenarios,
  screenshotMachineRuntimeScenarios,
  touchscreenMachineRuntimeScenarios,
} from "./runtime-scenarios";
import { getUiDebugScenario } from "./ui-debug-fixtures";

describe("machine runtime scenario matrix", () => {
  const testRouter = createRouter({
    history: createMemoryHistory(),
    routes: machineRoutes,
  });

  it("defines every foundational slice with route, fixture, and assertions", () => {
    expect(
      machineRuntimeScenarios.map((scenario) => scenario.category),
    ).toEqual(
      expect.arrayContaining([
        "ready_catalog",
        "product",
        "checkout",
        "payment",
        "dispensing",
        "result",
        "offline",
        "maintenance",
      ]),
    );

    const ids = new Set<string>();
    for (const scenario of machineRuntimeScenarios) {
      expect(scenario.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(ids.has(scenario.id)).toBe(false);
      ids.add(scenario.id);
      expect(scenario.name.trim()).not.toBe("");
      expect(scenario.targetRoute).toMatch(/^\//);
      expect(getUiDebugScenario(scenario.fixtureScenarioId).id).toBe(
        scenario.fixtureScenarioId,
      );
      expect(scenario.setup.length).toBeGreaterThan(0);
      expect(scenario.visualChecks.length).toBeGreaterThan(0);
      expect(scenario.touchChecks.length).toBeGreaterThan(0);
      expect(scenario.ciTier).toMatch(/^(smoke|full)$/);
    }
  });

  it("routes every target path through a concrete machine route", () => {
    for (const scenario of machineRuntimeScenarios) {
      const resolved = testRouter.resolve(scenario.targetRoute);
      expect(
        resolved.matched.map((route) => route.path),
        `${scenario.id} should resolve without the catch-all redirect`,
      ).not.toContain("/:pathMatch(.*)*");
      expect(resolved.matched.length).toBeGreaterThan(0);
    }
  });

  it("marks screenshot and touchscreen consumers from the shared matrix", () => {
    expect(screenshotMachineRuntimeScenarios.length).toBeGreaterThan(0);
    expect(touchscreenMachineRuntimeScenarios.length).toBeGreaterThan(0);

    for (const scenario of screenshotMachineRuntimeScenarios) {
      expect(scenario.screenshot).toBe("included");
    }
    for (const scenario of touchscreenMachineRuntimeScenarios) {
      expect(scenario.touchChecks.length).toBeGreaterThan(0);
    }
  });

  it("covers each dispensing reminder state as an independent screenshot scenario", () => {
    const dispensingStates = [
      {
        id: "dispensing",
        fixtureScenarioId: "dispensing",
        visualCheck: "展示出货初始状态",
      },
      {
        id: "dispensing-pickup-15s",
        fixtureScenarioId: "dispensing_pickup_15s",
        visualCheck: "展示 15 秒取货提醒",
      },
      {
        id: "dispensing-pickup-25s",
        fixtureScenarioId: "dispensing_pickup_25s",
        visualCheck: "展示 25 秒取货提醒",
      },
    ] as const;

    for (const expectation of dispensingStates) {
      const scenario = machineRuntimeScenarios.find(
        (candidate) => candidate.id === expectation.id,
      );
      expect(scenario).toBeDefined();
      expect(scenario?.category).toBe("dispensing");
      expect(scenario?.targetRoute).toBe("/dispensing");
      expect(scenario?.fixtureScenarioId).toBe(expectation.fixtureScenarioId);
      expect(scenario?.visualChecks).toContain(expectation.visualCheck);
      expect(scenario?.screenshot).toBe("included");
    }
  });

  it("covers both payment presentation modes as screenshot scenarios", () => {
    const paymentStates = [
      {
        id: "payment-qr",
        fixtureScenarioId: "payment_qr",
        visualCheck: "展示支付二维码区域",
      },
      {
        id: "payment-code",
        fixtureScenarioId: "payment_code",
        visualCheck: "展示扫码器就绪",
      },
    ] as const;

    for (const expectation of paymentStates) {
      const scenario = machineRuntimeScenarios.find(
        (candidate) => candidate.id === expectation.id,
      );
      expect(scenario).toBeDefined();
      expect(scenario?.category).toBe("payment");
      expect(scenario?.targetRoute).toBe("/payment");
      expect(scenario?.fixtureScenarioId).toBe(expectation.fixtureScenarioId);
      expect(scenario?.visualChecks).toContain(expectation.visualCheck);
      expect(scenario?.screenshot).toBe("included");
    }
  });

  it("covers the production Boot surface as a 1080x1920 screenshot scenario", () => {
    const scenario = getMachineRuntimeScenario("boot");
    expect(scenario.category).toBe("boot");
    expect(scenario.targetRoute).toBe("/boot");
    expect(scenario.fixtureScenarioId).toBe("ready");
    expect(scenario.screenshot).toBe("included");
    expect(scenario.visualChecks).toContain("复用生产 KioskHeader");
  });

  it("covers product browsing and checkout payment selection screenshots", () => {
    const states = [
      {
        id: "product-list",
        category: "product",
        targetRoute: "/catalog",
        visualCheck: "展示基础短袖商品卡",
      },
      {
        id: "product-detail",
        category: "product",
        targetRoute: "/products/product:550e8400-e29b-41d4-a716-446655440303",
        visualCheck: "展示基础短袖详情",
      },
      {
        id: "checkout-payment-options",
        category: "checkout",
        targetRoute: "/checkout",
        visualCheck: "展示选择支付方式",
      },
    ] as const;

    for (const expectation of states) {
      const scenario = machineRuntimeScenarios.find(
        (candidate) => candidate.id === expectation.id,
      );
      expect(scenario).toBeDefined();
      expect(scenario?.category).toBe(expectation.category);
      expect(scenario?.targetRoute).toBe(expectation.targetRoute);
      expect(scenario?.fixtureScenarioId).toBe("ready");
      expect(scenario?.visualChecks).toContain(expectation.visualCheck);
      expect(scenario?.screenshot).toBe("included");
    }
  });

  it("selects screenshot scenario subsets for artifact generation", () => {
    expect(selectScreenshotMachineRuntimeScenarios(undefined)).toEqual(
      screenshotMachineRuntimeScenarios,
    );
    expect(
      selectScreenshotMachineRuntimeScenarios("ready-catalog,offline"),
    ).toEqual([
      getMachineRuntimeScenario("ready-catalog"),
      getMachineRuntimeScenario("offline"),
    ]);
    expect(selectScreenshotMachineRuntimeScenarios("maintenance")).toEqual([
      getMachineRuntimeScenario("maintenance"),
    ]);

    expect(() =>
      selectScreenshotMachineRuntimeScenarios("unknown,deferred"),
    ).toThrow(
      "Unknown Machine Runtime Console screenshot scenario(s): unknown, deferred",
    );
  });
});
