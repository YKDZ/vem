import type { test as baseTest } from "@playwright/test";

const ENABLED_TARGETS = new Set(["isolated", "disposable"]);

export function adminMutationE2eTarget(): string {
  return process.env.VEM_ADMIN_MUTATION_E2E_TARGET?.trim() ?? "";
}

export function isAdminMutationE2eEnabled(): boolean {
  return ENABLED_TARGETS.has(adminMutationE2eTarget());
}

export function skipUnlessAdminMutationE2eEnabled(test: typeof baseTest): void {
  test.skip(
    !isAdminMutationE2eEnabled(),
    "Admin UI mutation E2E must run only against an isolated or disposable backend. Set VEM_ADMIN_MUTATION_E2E_TARGET=isolated or disposable.",
  );
}
