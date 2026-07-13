import { describe, expect, it } from "vitest";

import { routes } from "./routes";

describe("系统配置路由", () => {
  it("用系统配置入口取代独立的和风天气页面", () => {
    const children = routes.flatMap((route) => route.children ?? []);
    const settings = children.find((route) => route.name === "system-settings");

    expect(settings?.path).toBe("system-settings");
    expect(settings?.meta?.title).toBe("系统配置");
    expect(settings?.meta?.requiredPermissions).toBeUndefined();
    expect(children.some((route) => route.name === "qweather")).toBe(false);
    expect(children.some((route) => route.path === "qweather")).toBe(false);
    expect(children.some((route) => route.name === "admin-users")).toBe(false);
    expect(children.some((route) => route.name === "roles")).toBe(false);
  });
});
