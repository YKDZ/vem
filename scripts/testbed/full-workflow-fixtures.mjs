const FIXTURE_TRACK_KEYS = Object.freeze([
  "sale",
  "scannerPayment",
  "visionExperience",
  "fulfillmentRecovery",
  "pickupProtocol",
  "ipcRecovery",
  "stockMaintenance",
]);

const FIXTURE_SLOT_CODES = Object.freeze([
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

function fixtureForSlot(slots, slotCode) {
  const fixture = slots.find((slot) => slot?.slotCode === slotCode);
  if (!fixture) throw new Error(`requires seeded fixture slot ${slotCode}`);
  return {
    slotCode,
    inventoryId: required(
      fixture.inventoryId,
      `fixture ${slotCode} inventoryId`,
    ),
    onHandQty: Number.isInteger(fixture.onHandQty) ? fixture.onHandQty : null,
    sku: required(fixture.sku, `fixture ${slotCode} sku`),
  };
}

export function allocateFullWorkflowFixtures(slots) {
  if (!Array.isArray(slots))
    throw new Error("seeded fixture slots are required");
  const allocation = Object.fromEntries(
    FIXTURE_TRACK_KEYS.map((key, index) => [
      key,
      fixtureForSlot(slots, FIXTURE_SLOT_CODES[index]),
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
  const slotCode = required(fixture?.slotCode, `${trackKey} fixture slotCode`);
  if (!/^[A-Za-z0-9_-]+$/.test(slotCode)) {
    throw new Error(`${trackKey} fixture slotCode is invalid`);
  }
  return `[data-test="catalog-product"][data-slot-code="${slotCode}"]`;
}
