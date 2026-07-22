const FIXTURE_TRACK_KEYS = Object.freeze([
  "sale",
  "scannerPayment",
  "visionExperience",
  "fulfillmentRecovery",
  "pickupProtocol",
  "ipcRecovery",
  "stockMaintenance",
]);

const FIXTURE_SLOT_DISPLAY_LABELS = Object.freeze([
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "B1",
  "B2",
]);

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function fixtureForSlot(slots, slotDisplayLabel) {
  const fixture = slots.find(
    (slot) => slot?.slotDisplayLabel === slotDisplayLabel,
  );
  if (!fixture)
    throw new Error(`requires seeded fixture slot ${slotDisplayLabel}`);
  return {
    slotDisplayLabel,
    inventoryId: required(
      fixture.inventoryId,
      `fixture ${slotDisplayLabel} inventoryId`,
    ),
    onHandQty: Number.isInteger(fixture.onHandQty) ? fixture.onHandQty : null,
    sku: required(fixture.sku, `fixture ${slotDisplayLabel} sku`),
  };
}

export function allocateFullWorkflowFixtures(slots) {
  if (!Array.isArray(slots))
    throw new Error("seeded fixture slots are required");
  const allocation = Object.fromEntries(
    FIXTURE_TRACK_KEYS.map((key, index) => [
      key,
      fixtureForSlot(slots, FIXTURE_SLOT_DISPLAY_LABELS[index]),
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
  const slotDisplayLabel = required(
    fixture?.slotDisplayLabel,
    `${trackKey} fixture slotDisplayLabel`,
  );
  if (!/^[A-Za-z0-9_-]+$/.test(slotDisplayLabel)) {
    throw new Error(`${trackKey} fixture slotDisplayLabel is invalid`);
  }
  return `[data-test="catalog-product"][data-slot-id="${slotDisplayLabel}"]`;
}
