import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateFullWorkflowFixtures,
  catalogProductSelectorForFixture,
} from "./full-workflow-fixtures.mjs";

describe("full workflow fixture allocation", () => {
  it("allocates an independent seeded slot to each fixed track", () => {
    const allocation = allocateFullWorkflowFixtures(
      ["A1", "A2", "A3", "A4", "A5", "B1", "B2"].map(
        (slotDisplayLabel, index) => ({
          slotId: `550e8400-e29b-41d4-a716-44665544000${index + 1}`,
          rowNo: index < 5 ? 1 : 2,
          cellNo: index < 5 ? index + 1 : index - 4,
          slotDisplayLabel,
          inventoryId: `inventory-${index + 1}`,
          onHandQty: slotDisplayLabel === "B2" ? 1 : 3,
          sku: `TSC-LOCAL-${String(index + 1).padStart(3, "0")}`,
        }),
      ),
    );
    assert.deepEqual(
      Object.values(allocation).map((fixture) => fixture.slotDisplayLabel),
      ["A1", "A2", "A3", "A4", "A5", "B1", "B2"],
    );
    assert.equal(
      catalogProductSelectorForFixture(allocation, "scannerPayment"),
      '[data-test="catalog-product"][data-slot-id="550e8400-e29b-41d4-a716-446655440002"]',
    );
    assert.deepEqual(allocation.stockMaintenance, {
      slotDisplayLabel: "B2",
      slotId: "550e8400-e29b-41d4-a716-446655440007",
      rowNo: 2,
      cellNo: 2,
      inventoryId: "inventory-7",
      onHandQty: 1,
      sku: "TSC-LOCAL-007",
    });
  });

  it("rejects missing or reused slots rather than allowing track-order stock coupling", () => {
    assert.throws(
      () =>
        allocateFullWorkflowFixtures([
          {
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            rowNo: 1,
            cellNo: 1,
            slotDisplayLabel: "A1",
            inventoryId: "a",
            sku: "TSC-LOCAL-001",
          },
        ]),
      /requires seeded fixture slot R1C2/,
    );
    assert.throws(
      () =>
        allocateFullWorkflowFixtures(
          ["A1", "A2", "A3", "A4", "A5", "B1", "B2"].map(
            (slotDisplayLabel) => ({
              slotId: `550e8400-e29b-41d4-a716-4466554400${slotDisplayLabel.length}0`,
              rowNo: slotDisplayLabel.startsWith("A") ? 1 : 2,
              cellNo: Number(slotDisplayLabel[1]),
              slotDisplayLabel,
              inventoryId: "shared",
              sku: "TSC-LOCAL-001",
            }),
          ),
        ),
      /reuses inventory shared/,
    );
  });
});
