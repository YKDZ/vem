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

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function fixtureForSlot(
  slots: JsonRecord[],
  coordinate: { rowNo: number; cellNo: number },
): JsonRecord {
  const fixture = slots.find(
    (slot: JsonRecord) =>
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
    categoryKey: required(fixture.categoryKey, "fixture categoryKey"),
    inventoryId: required(
      fixture.inventoryId,
      `fixture ${fixture.slotId} inventoryId`,
    ),
    onHandQty: Number.isInteger(fixture.onHandQty)
      ? fixture.onHandQty
      : null,
    sku: required(fixture.sku, `fixture ${fixture.slotId} sku`),
  };
}

export function allocateFullWorkflowFixtures(
  slots: unknown,
): JsonRecord {
  if (!Array.isArray(slots))
    throw new Error("seeded fixture slots are required");
  const allocation = Object.fromEntries(
    FIXTURE_TRACK_KEYS.map((key, index: number) => [
      key,
      fixtureForSlot(
        arrayValue(slots).map((slot: unknown) => recordValue(slot)),
        FIXTURE_SLOT_COORDINATES[index],
      ),
    ]),
  );
  const usedInventoryIds = new Set();
  for (const fixture of Object.values(allocation)) {
    const fixtureRecord = recordValue(fixture);
    if (usedInventoryIds.has(fixtureRecord.inventoryId)) {
      throw new Error(
        `full workflow fixture allocation reuses inventory ${fixtureRecord.inventoryId}`,
      );
    }
    usedInventoryIds.add(fixtureRecord.inventoryId);
  }
  return allocation;
}

export function catalogProductSelectorForFixture(
  allocation: JsonRecord | null | undefined,
  trackKey: string,
): string {
  const fixture = recordValue(allocation?.[trackKey]);
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

export function catalogCategorySelectorForFixture(
  allocation: JsonRecord | null | undefined,
  trackKey: string,
): string {
  const fixture = recordValue(allocation?.[trackKey]);
  const categoryKey = required(
    fixture?.categoryKey,
    `${trackKey} fixture categoryKey`,
  );
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(categoryKey))
    throw new Error(`${trackKey} fixture categoryKey is invalid`);
  return `[data-test="catalog-category"][data-category-key="${categoryKey}"]:not(:disabled)`;
}
