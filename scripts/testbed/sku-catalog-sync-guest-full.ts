#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  adminToken,
  daemonGet,
  fetchJson,
  option,
  platform,
  required,
  restoreBaselinePlanogramAndStock,
  rows,
  writeJson,
  type HandoffRecord,
  type JsonRecord,
} from "./fault-recovery-guest-full.ts";
import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

const SCHEMA_VERSION = "vem-sku-catalog-sync-guest-full/v1";
const TARGET_SLOT_COUNT = 40;

function localPath(value: unknown): string {
  const path = required(value, "Windows path");
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readLocalJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(localPath(path), "utf8")) as JsonRecord;
}

export function parseSkuCatalogSyncGuestArgs(args: string[]): {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string;
} {
  if (option(args, "mode") !== "full") throw new Error("--mode must be full");
  return {
    mode: "full",
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
    fixtureKey: option(args, "fixture-key"),
  };
}

function slotCoordinates(): Array<{ rowNo: number; cellNo: number }> {
  const coordinates: Array<{ rowNo: number; cellNo: number }> = [];
  for (let rowNo = 1; rowNo <= 6; rowNo += 1) {
    for (let cellNo = 1; cellNo <= 5; cellNo += 1) {
      coordinates.push({ rowNo, cellNo });
    }
  }
  for (let cellNo = 1; cellNo <= 4; cellNo += 1) {
    coordinates.push({ rowNo: 7, cellNo });
  }
  for (let cellNo = 1; cellNo <= 3; cellNo += 1) {
    coordinates.push({ rowNo: 8, cellNo });
    coordinates.push({ rowNo: 9, cellNo });
  }
  return coordinates;
}

async function adminRequest(
  input: JsonRecord,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const bootstrap = input.runtimeBootstrap as JsonRecord | undefined;
  const base = required(
    bootstrap?.provisioningApiBaseUrl,
    "runtimeBootstrap.provisioningApiBaseUrl",
  ).replace(/\/+$/, "");
  return fetchJson(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function runSkuCatalogSyncGuest(options: {
  mode: "full";
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
  fixtureKey: string;
}): Promise<JsonRecord> {
  const report: JsonRecord = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    mode: options.mode,
    evidence: {},
  };
  let client: InstanceType<typeof CdpClient> | null = null;
  try {
    const guestInput = readLocalJson(options.guestInputPath);
    const handoff = readLocalJson(options.handoffPath) as HandoffRecord;
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const token = await adminToken(guestInput);
    const baselineReport = (await platform(
      guestInput,
      runId,
      machineCode,
      null,
    )) as JsonRecord;
    const machinesEnvelope = (await adminRequest(
      guestInput,
      token,
      "GET",
      "/machines?page=1&pageSize=100",
    )) as JsonRecord;
    const machine = (
      (machinesEnvelope.data as JsonRecord | undefined)?.items as
        | JsonRecord[]
        | undefined
    )?.find(
      (candidate) => candidate.code === machineCode,
    );
    const machineId = required(machine?.id, "machine id");
    report.machineId = machineId;
    const baselineSaleView = (await daemonGet(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord;
    (report.evidence as JsonRecord).baselineSaleView = baselineSaleView;

    const productsEnvelope = (await adminRequest(
      guestInput,
      token,
      "GET",
      "/products?page=1&pageSize=100",
    )) as JsonRecord;
    const variantsEnvelope = (await adminRequest(
      guestInput,
      token,
      "GET",
      "/product-variants?page=1&pageSize=200",
    )) as JsonRecord;
    const products =
      ((productsEnvelope.data as JsonRecord | undefined)?.items as
        | JsonRecord[]
        | undefined) ?? [];
    const variants =
      ((variantsEnvelope.data as JsonRecord | undefined)?.items as
        | JsonRecord[]
        | undefined) ?? [];
    const categoryNameFor = (productName: string): string => {
      if (productName.includes("T恤") || productName.includes("T·"))
        return "T恤";
      if (productName.includes("袜")) return "袜子";
      if (productName.includes("内裤")) return "内裤";
      return "其他";
    };
    const inventoriesRows = rows(baselineReport, "inventories") as JsonRecord[];
    if (variants.length === 0 || products.length === 0) {
      throw new Error("fixture platform report has no products or variants");
    }

    const existingSlotsEnvelope = (await adminRequest(
      guestInput,
      token,
      "GET",
      `/machines/${machineId}/slots`,
    )) as JsonRecord;
    const existingSlots = {
      items:
        (existingSlotsEnvelope.data as JsonRecord | undefined)?.items ?? [],
    };
    const slotsByKey = new Map<string, JsonRecord>();
    for (const slot of (existingSlots.items ?? []) as JsonRecord[]) {
      slotsByKey.set(`${slot.rowNo}:${slot.cellNo}`, slot);
    }
    for (const coordinate of slotCoordinates()) {
      const key = `${coordinate.rowNo}:${coordinate.cellNo}`;
      if (slotsByKey.has(key)) continue;
      const created = (await adminRequest(
        guestInput,
        token,
        "POST",
        `/machines/${machineId}/slots`,
        {
          rowNo: coordinate.rowNo,
          cellNo: coordinate.cellNo,
          capacity: 10,
          status: "enabled",
        },
      )) as JsonRecord;
      slotsByKey.set(key, created);
    }
    const allSlots = [...slotsByKey.values()];
    if (allSlots.length !== TARGET_SLOT_COUNT) {
      throw new Error(
        `expected ${TARGET_SLOT_COUNT} slots, got ${allSlots.length}`,
      );
    }

    const inventoryBySlot = new Map<string, JsonRecord>();
    for (const inventory of inventoriesRows) {
      inventoryBySlot.set(String(inventory.slotId), inventory);
    }
    const variantById = new Map(
      variants.map((variant) => [String(variant.id), variant]),
    );
    const productById = new Map(
      products.map((product) => [String(product.id), product]),
    );
    let variantIndex = 0;
    for (const slot of allSlots) {
      const slotId = String(slot.id);
      if (inventoryBySlot.has(slotId)) continue;
      const variant = variants[variantIndex % variants.length] as JsonRecord;
      variantIndex += 1;
      const created = (await adminRequest(
        guestInput,
        token,
        "POST",
        "/inventories",
        {
          machineId,
          slotId,
          variantId: variant.id,
          onHandQty: 5,
          lowStockThreshold: 1,
          note: "sku-catalog-sync fixture inventory",
        },
      )) as JsonRecord;
      inventoryBySlot.set(slotId, created);
    }

    const targetFixture = (
      guestInput.fixtureAllocation as JsonRecord | undefined
    )?.[options.fixtureKey] as JsonRecord | undefined;
    const targetSlotId = required(
      targetFixture?.slotId,
      `${options.fixtureKey} slotId`,
    );
    const currentInventory = inventoryBySlot.get(targetSlotId);
    const currentVariant = currentInventory
      ? variantById.get(String(currentInventory.variantId))
      : null;
    const targetVariant = variants.find(
      (candidate) =>
        String(candidate.id) !== String(currentVariant?.id) &&
        candidate.status === "active",
    ) as JsonRecord | undefined;
    if (!targetVariant) throw new Error("no replacement variant available");
    const planogramVersion = `PLAN-SKU-CATALOG-${Date.now()}`;
    const slotsPayload = allSlots.map((slot) => {
      const slotId = String(slot.id);
      const inventory = inventoryBySlot.get(slotId) as JsonRecord;
      const isTarget = slotId === targetSlotId;
      const variant = isTarget
        ? targetVariant
        : (variantById.get(String(inventory.variantId)) as JsonRecord);
      const product = productById.get(String(variant.productId)) as JsonRecord;
      return {
        slotId,
        rowNo: Number(slot.rowNo),
        cellNo: Number(slot.cellNo),
        capacity: 10,
        parLevel: 5,
        inventoryId: String(inventory.id),
        variantId: String(variant.id),
        productId: String(product.id),
        productName: String(product.name),
        productDescription: String(product.description ?? ""),
        coverImageUrl: null,
        categoryId: null,
        categoryName: categoryNameFor(String(product.name)),
        sku: String(variant.sku),
        size: String(variant.size ?? ""),
        color: String(variant.color ?? ""),
        priceCents: Number(variant.price_cents),
        productSortOrder: Number(product.sort_order ?? 0),
        targetGender: variant.target_gender ?? null,
      };
    });
    (report.evidence as JsonRecord).published = await adminRequest(
      guestInput,
      token,
      "POST",
      `/machines/${machineId}/planogram-versions`,
      { planogramVersion, slots: slotsPayload },
    );

    const deadline = Date.now() + 90_000;
    let saleView: JsonRecord | null = null;
    do {
      saleView = (await daemonGet(handoff, "/v1/sale-view")) as JsonRecord;
      if (saleView.planogramVersion === planogramVersion) break;
      await sleep(1_000);
    } while (Date.now() < deadline);
    if (saleView?.planogramVersion !== planogramVersion) {
      throw new Error(
        `daemon did not adopt ${planogramVersion}; saw ${String(saleView?.planogramVersion)}`,
      );
    }
    if (
      (saleView.items as unknown[] | undefined)?.length !== TARGET_SLOT_COUNT
    ) {
      throw new Error(
        `expected ${TARGET_SLOT_COUNT} sale-view items, got ${String((saleView.items as unknown[] | undefined)?.length)}`,
      );
    }
    const targetItem = (saleView.items as JsonRecord[]).find(
      (item) => item.slotId === targetSlotId,
    );
    if (targetItem?.sku !== String(targetVariant.sku)) {
      throw new Error(
        `target slot SKU did not change to ${String(targetVariant.sku)}; saw ${String(targetItem?.sku)}`,
      );
    }
    (report.evidence as JsonRecord).saleView = saleView;

    const handoffCdp = handoff.cdp as JsonRecord;
    const cdpTarget = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: String(handoffCdp.targetId),
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        cdpTarget.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    await activateVisibleSelector(
      client,
      `[data-test="catalog-category"][data-category-key="${String(
        targetFixture?.categoryKey ?? "socks",
      )}"]:not(:disabled)`,
      { kind: "touch", timeoutMs: 30_000 },
    );
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    await evaluateExpression(
      client,
      `(() => {
        const el = document.querySelector('[data-test="catalog-product"][data-variant-id="${String(
          targetVariant.id,
        )}"]');
        return el !== null;
      })()`,
    ).then((visible) => {
      if (visible !== true) {
        throw new Error("changed SKU product is not visible in the catalog");
      }
    });
    const screenshotPath = join(
      dirname(localPath(options.outPath)),
      "sku-catalog-sync-artifacts",
      "catalog-after-sync.png",
    );
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await captureCheckpoint(client, "catalog-after-sync", {
      screenshot: true,
      screenshotSink: ({ bytes }) => {
        writeFileSync(screenshotPath, bytes);
        return { ref: screenshotPath };
      },
    });
    (report.evidence as JsonRecord).screenshot = screenshotPath;
    (report.evidence as JsonRecord).restore =
      await restoreBaselinePlanogramAndStock({
        guestInput,
        handoff,
        token,
        machineId,
        baselineSaleView,
        fixtures:
          (guestInput.fixtureAllocation as JsonRecord | undefined) ?? {},
      });
    report.assertions = {
      planogramAdopted: true,
      fortySlotSaleView: true,
      targetSkuChanged: true,
      catalogShowsChangedSku: true,
    };
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    writeJson(options.outPath, report);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSkuCatalogSyncGuest(
    parseSkuCatalogSyncGuestArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
