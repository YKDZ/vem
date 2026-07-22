import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateFullWorkflowFixtures,
  catalogProductSelectorForFixture,
} from "./full-workflow-fixtures.mjs";

describe("full workflow fixture allocation", () => {
  it("allocates an independent seeded slot to each fixed track", () => {
    const allocation = allocateFullWorkflowFixtures(
      ["A1", "A2", "A3", "A4", "A5", "B1", "B2"].map((slotCode, index) => ({
        slotCode,
        inventoryId: `inventory-${index + 1}`,
        onHandQty: slotCode === "B2" ? 1 : 3,
        sku: `TSC-LOCAL-${String(index + 1).padStart(3, "0")}`,
      })),
    );
    assert.deepEqual(
      Object.values(allocation).map((fixture) => fixture.slotCode),
      ["A1", "A2", "A3", "A4", "A5", "B1", "B2"],
    );
    assert.equal(
      catalogProductSelectorForFixture(allocation, "scannerPayment"),
      '[data-test="catalog-product"][data-slot-code="A2"]',
    );
    assert.deepEqual(allocation.stockMaintenance, {
      slotCode: "B2",
      inventoryId: "inventory-7",
      onHandQty: 1,
      sku: "TSC-LOCAL-007",
    });
  });

  it("rejects missing or reused slots rather than allowing track-order stock coupling", () => {
    assert.throws(
      () =>
        allocateFullWorkflowFixtures([
          { slotCode: "A1", inventoryId: "a", sku: "TSC-LOCAL-001" },
        ]),
      /requires seeded fixture slot A2/,
    );
    assert.throws(
      () =>
        allocateFullWorkflowFixtures(
          ["A1", "A2", "A3", "A4", "A5", "B1", "B2"].map((slotCode) => ({
            slotCode,
            inventoryId: "shared",
            sku: "TSC-LOCAL-001",
          })),
        ),
      /reuses inventory shared/,
    );
  });
});
