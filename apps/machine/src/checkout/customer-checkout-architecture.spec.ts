import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const machineRoot = fileURLToPath(new URL("../..", import.meta.url));

function readSource(path: string): string {
  return readFileSync(`${machineRoot}/${path}`, "utf8");
}

describe("customer checkout projection architecture", () => {
  it("keeps removed current transaction models out of the checkout store", () => {
    const checkoutStore = readSource("src/stores/checkout.ts");

    expect(checkoutStore).not.toMatch(/\bcurrentOrder\b/);
    expect(checkoutStore).not.toMatch(/\bflowStep\b/);
    expect(checkoutStore).not.toMatch(/\btransactionObservation\b/);
    expect(checkoutStore).not.toMatch(/\bstatus:\s+null as MachineOrderStatus/);
    expect(checkoutStore).not.toMatch(/\bnormalizeNextAction\b/);
  });

  it("routes current transactions through the projection instead of a raw next-action table", () => {
    const startup = readSource("src/daemon/startup.ts");

    expect(startup).toContain("projectCustomerCheckoutView");
    expect(startup).not.toMatch(/next\s*===\s*"wait_payment"/);
    expect(startup).not.toMatch(/next\s*===\s*"dispensing"/);
    expect(startup).not.toMatch(/next\s*===\s*"success"/);
    expect(startup).not.toMatch(/next\s*===\s*"payment_failed"/);
    expect(startup).not.toMatch(/next\s*===\s*"refund_pending"/);
  });
});
