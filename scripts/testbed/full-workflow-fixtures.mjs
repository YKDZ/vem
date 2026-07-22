const FIXTURE_TRACK_KEYS = Object.freeze([
  "sale",
  "scannerPayment",
  "visionExperience",
  "fulfillmentRecovery",
  "pickupProtocol",
  "ipcRecovery",
  "stockMaintenance",
]);

const FIXTURE_SLOT_COORDINATES = Object.freeze([
  { rowNo: 1, cellNo: 1 },
  { rowNo: 1, cellNo: 2 },
  { rowNo: 1, cellNo: 3 },
  { rowNo: 1, cellNo: 4 },
  { rowNo: 1, cellNo: 5 },
  { rowNo: 2, cellNo: 1 },
  { rowNo: 2, cellNo: 2 },
]);

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function fixtureForSlot(slots, coordinate) {
  const fixture = slots.find(
    (slot) =>
      slot?.rowNo === coordinate.rowNo && slot?.cellNo === coordinate.cellNo,
  );
  if (!fixture)
    throw new Error(
      `requires seeded fixture slot R${coordinate.rowNo}C${coordinate.cellNo}`,
    );
  return {
    slotId: required(fixture.slotId, "fixture slotId"),
    rowNo: coordinate.rowNo,
    cellNo: coordinate.cellNo,
    slotDisplayLabel: required(
      fixture.slotDisplayLabel,
      "fixture slotDisplayLabel",
    ),
    inventoryId: required(
      fixture.inventoryId,
      `fixture ${fixture.slotId} inventoryId`,
    ),
    onHandQty: Number.isInteger(fixture.onHandQty) ? fixture.onHandQty : null,
    sku: required(fixture.sku, `fixture ${fixture.slotId} sku`),
  };
}

export function allocateFullWorkflowFixtures(slots) {
  if (!Array.isArray(slots))
    throw new Error("seeded fixture slots are required");
  const allocation = Object.fromEntries(
    FIXTURE_TRACK_KEYS.map((key, index) => [
      key,
      fixtureForSlot(slots, FIXTURE_SLOT_COORDINATES[index]),
    ]),
  );
  const usedInventoryIds = new Set();
  for (const fixture of Object.values(allocation)) {
    if (usedInventoryIds.has(fixture.inventoryId)) {
      throw new Error(
        `full workflow fixture allocation reuses inventory ${fixture.inventoryId}`,
      );
    }
    usedInventoryIds.add(fixture.inventoryId);
  }
  return allocation;
}

export function catalogProductSelectorForFixture(allocation, trackKey) {
  const fixture = allocation?.[trackKey];
  const slotId = required(fixture?.slotId, `${trackKey} fixture slotId`);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      slotId,
    )
  ) {
    throw new Error(`${trackKey} fixture slotId is invalid`);
  }
  return `[data-test="catalog-product"][data-slot-id="${slotId}"]`;
}
