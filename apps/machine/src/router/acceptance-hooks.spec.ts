// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import {
  installMachineRouteAcceptanceHooks,
  MACHINE_ROUTE_CHANGED_EVENT,
  MACHINE_ROUTE_NAME_ATTRIBUTE,
  MACHINE_ROUTE_PATH_ATTRIBUTE,
} from "./acceptance-hooks";

describe("machine route acceptance hooks", () => {
  afterEach(() => {
    document.body.removeAttribute(MACHINE_ROUTE_NAME_ATTRIBUTE);
    document.body.removeAttribute(MACHINE_ROUTE_PATH_ATTRIBUTE);
  });

  it("updates body route identity attrs and emits route-changed events synchronously", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/maintenance", name: "maintenance", component: {} },
      ],
    });
    const events: CustomEvent[] = [];
    window.addEventListener(MACHINE_ROUTE_CHANGED_EVENT, (event) => {
      events.push(event as CustomEvent);
    });
    installMachineRouteAcceptanceHooks(router);

    const catalogNavigation = router.push("/catalog");
    expect(events).toHaveLength(0);
    await catalogNavigation;

    expect(document.body.getAttribute(MACHINE_ROUTE_NAME_ATTRIBUTE)).toBe(
      "catalog",
    );
    expect(document.body.getAttribute(MACHINE_ROUTE_PATH_ATTRIBUTE)).toBe(
      "/catalog",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      routeName: "catalog",
      routePath: "/catalog",
      routeFullPath: "/catalog",
      fromRouteName: "",
      fromRoutePath: "/",
      fromRouteFullPath: "/",
    });

    await router.push("/maintenance");

    expect(document.body.getAttribute(MACHINE_ROUTE_NAME_ATTRIBUTE)).toBe(
      "maintenance",
    );
    expect(document.body.getAttribute(MACHINE_ROUTE_PATH_ATTRIBUTE)).toBe(
      "/maintenance",
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.detail).toEqual({
      routeName: "maintenance",
      routePath: "/maintenance",
      routeFullPath: "/maintenance",
      fromRouteName: "catalog",
      fromRoutePath: "/catalog",
      fromRouteFullPath: "/catalog",
    });
  });
});
