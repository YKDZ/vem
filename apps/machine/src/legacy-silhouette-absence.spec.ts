import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(import.meta.dirname, path), "utf8");

const workspaceSource = (path: string) =>
  readFileSync(resolve(import.meta.dirname, "../../..", path), "utf8");

describe("legacy silhouette hard removal", () => {
  it("does not retain a customer route, UI entry, resolver, or V1 fixture", () => {
    expect(source("router/routes.ts")).not.toContain("virtual-try-on");
    expect(source("views/ProductDetailView.vue")).not.toContain(
      "tryOnSilhouette",
    );
    expect(source("catalog/managed-media.ts")).not.toContain(
      "resolveManagedMediaReference",
    );
    expect(source("views/ProductDetailView.vue")).not.toContain(
      "platformApiBaseUrl",
    );
    expect(source("views/sale-start-capability-flow.spec.ts")).not.toContain(
      "tryOnSilhouette",
    );
    expect(source("views/sale-start-capability-flow.spec.ts")).not.toContain(
      "VirtualTryOnView",
    );
    expect(
      workspaceSource("apps/service-api/src/machines/machines.service.ts"),
    ).not.toContain("tryOnSilhouette");
    expect(
      workspaceSource("packages/shared/src/schemas/machines.ts"),
    ).not.toContain("tryOnSilhouette");
  });
});
