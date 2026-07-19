import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateFullWorkflowFixtures,
  catalogProductSelectorForFixture,
} from "./full-workflow-fixtures.mjs";

describe("full workflow fixture allocation", () => {
  it("allocates an independent seeded slot to each fixed track", () => {
    const allocation = allocateFullWorkflowFixtures(
      ["A1", "A2", "A3", "A4", "A5", "B1"].map((slotCode, index) => ({
        slotCode,
        inventoryId: `inventory-${index + 1}`,
        onHandQty: 3,
      })),
    );
    assert.deepEqual(
      Object.values(allocation).map((fixture) => fixture.slotCode),
      ["A1", "A2", "A3", "A4", "A5", "B1"],
    );
    assert.equal(
      catalogProductSelectorForFixture(allocation, "scanner"),
      '[data-test="catalog-product"][data-slot-code="A2"]',
    );
  });

  it("rejects missing or reused slots rather than allowing track-order stock coupling", () => {
    assert.throws(
      () =>
        allocateFullWorkflowFixtures([{ slotCode: "A1", inventoryId: "a" }]),
      /requires seeded fixture slot A2/,
    );
    assert.throws(
      () =>
        allocateFullWorkflowFixtures(
          ["A1", "A2", "A3", "A4", "A5", "B1"].map((slotCode) => ({
            slotCode,
            inventoryId: "shared",
          })),
        ),
      /reuses inventory shared/,
    );
  });
});
