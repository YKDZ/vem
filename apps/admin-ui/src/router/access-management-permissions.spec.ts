import { permissionCodeSchema } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { routes } from "./routes";

describe("Admin Identity permission gates", () => {
  it("uses shared Permission Code values for identity routes and actions", () => {
    const routeNames = routes
      .flatMap((route) => route.children ?? [])
      .map((route) => route.name);
    expect(routeNames).toContain("system-settings");

    expect(permissionCodeSchema.parse("adminUsers.write")).toBe(
      "adminUsers.write",
    );
  });
});
