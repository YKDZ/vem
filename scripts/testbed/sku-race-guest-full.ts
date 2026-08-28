#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  adminToken,
  control,
  daemonGet,
  fetchJson,
  option,
  platform,
  readPaymentSurface,
  readUi,
  required,
  restoreBaselinePlanogramAndStock,
  rows,
  selectMockPaymentAndSubmit,
  waitForCommand,
  writeJson,
  type HandoffRecord,
  type JsonRecord,
} from "./fault-recovery-guest-full.ts";
import {
  activateVisibleSelector,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";
import { openFixtureProductFromCatalog } from "./payment-recovery-guest-full.ts";
import { waitForSaleStartCapability } from "./scanner-payment-code-guest-full.ts";

const SCHEMA_VERSION = "vem-sku-race-guest-full/v1";

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

export function parseSkuRaceGuestArgs(args: string[]): {
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

export async function runSkuRaceGuest(options: {
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
  let session: JsonRecord | null = null;
  let cleaned = false;
  let guestInput: JsonRecord | null = null;
  try {
    guestInput = readLocalJson(options.guestInputPath);
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
    )?.find((candidate) => candidate.code === machineCode);
    const machineId = required(machine?.id, "machine id");
    const fixture = (guestInput.fixtureAllocation as JsonRecord | undefined)?.[
      options.fixtureKey
    ] as JsonRecord | undefined;
    const targetSlotId = required(
      fixture?.slotId,
      `${options.fixtureKey} slotId`,
    );
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
      "/product-variants?page=1&pageSize=100",
    )) as JsonRecord;
    const products =
      ((productsEnvelope.data as JsonRecord | undefined)?.items as
        | JsonRecord[]
        | undefined) ?? [];
    const variants =
      ((variantsEnvelope.data as JsonRecord | undefined)?.items as
        | JsonRecord[]
        | undefined) ?? [];
    const inventoriesRows = rows(baselineReport, "inventories") as JsonRecord[];
    const targetInventory = inventoriesRows.find(
      (inventory) => inventory.slotId === targetSlotId,
    );
    const currentVariant = variants.find(
      (variant) => variant.id === targetInventory?.variantId,
    );
    const replacementVariant = variants.find(
      (variant) =>
        variant.id !== currentVariant?.id && variant.status === "active",
    ) as JsonRecord | undefined;
    if (!replacementVariant)
      throw new Error("no replacement variant available");
    const replacementProduct = products.find(
      (product) => product.id === replacementVariant.productId,
    ) as JsonRecord | undefined;
    const categoryNameFor = (productName: string): string => {
      if (productName.includes("T恤") || productName.includes("T·"))
        return "T恤";
      if (productName.includes("袜")) return "袜子";
      if (productName.includes("内裤")) return "内裤";
      return "其他";
    };
    const oldSaleView = (await daemonGet(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord;
    const oldPlanogramVersion = required(
      oldSaleView.planogramVersion,
      "baseline planogramVersion",
    );

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
    await waitForSaleStartCapability((path) => daemonGet(handoff, path), {
      paymentOptionKey: "mock:mock",
    });

    session = (await control(guestInput, "/v1/serial-sessions/start", {
      runId,
      machineCode,
      serialScenario: "normal",
      saleCorrelationId: `sale-correlation://sku-race-${Date.now()}`,
      targetIdentity: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)?.targetIdentity,
        "hostControlPlane.targetIdentity",
      ),
      runtimeBase: required(
        (guestInput.hostControlPlane as JsonRecord | undefined)
          ?.runtimeBaseIdentity,
        "hostControlPlane.runtimeBaseIdentity",
      ),
    })) as JsonRecord;
    const sessionId = String(session.sessionId);

    await openFixtureProductFromCatalog({
      client,
      slotId: targetSlotId,
      categoryKey: required(
        fixture?.categoryKey,
        `${options.fixtureKey} categoryKey`,
      ),
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await activateVisibleSelector(client, '[data-test="product-buy"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, "#/checkout", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await selectMockPaymentAndSubmit(client);
    const sale = await readPaymentSurface(client);
    const bootstrap = guestInput.runtimeBootstrap as JsonRecord | undefined;
    const currentTransaction = (await daemonGet(
      handoff,
      "/v1/transactions/current",
    )) as JsonRecord;
    await fetchJson(
      `${required(bootstrap?.provisioningApiBaseUrl, "runtimeBootstrap.provisioningApiBaseUrl").replace(/\/+$/, "")}/payments/mock/${encodeURIComponent(required(currentTransaction.paymentNo, "paymentNo"))}/complete`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    const liveSale = await waitForCommand(handoff, sale);
    await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/bind-sale`,
      liveSale,
    );
    await control(guestInput, `/v1/serial-sessions/${sessionId}/wait-frame`, {
      parsedOpcode: "VEND",
      timeoutMs: 30_000,
    });
    await control(guestInput, `/v1/serial-sessions/${sessionId}/wait-frame`, {
      parsedOpcode: "F0",
      timeoutMs: 30_000,
    });

    const newPlanogramVersion = `PLAN-SKU-RACE-${Date.now()}`;
    const payloadSlots = (oldSaleView.items as JsonRecord[]).map((item) => ({
      slotId: item.slotId,
      rowNo: item.rowNo,
      cellNo: item.cellNo,
      capacity: item.capacity,
      parLevel: item.parLevel,
      inventoryId: item.inventoryId,
      variantId:
        item.slotId === targetSlotId ? replacementVariant.id : item.variantId,
      productId:
        item.slotId === targetSlotId
          ? replacementVariant.productId
          : item.productId,
      productName:
        item.slotId === targetSlotId
          ? String(replacementProduct?.name ?? item.productName)
          : item.productName,
      productDescription: item.productDescription,
      coverImageUrl: item.coverImageUrl,
      categoryId: item.slotId === targetSlotId ? null : item.categoryId,
      categoryName:
        item.slotId === targetSlotId
          ? categoryNameFor(String(replacementProduct?.name ?? ""))
          : item.categoryName,
      sku:
        item.slotId === targetSlotId
          ? String(replacementVariant.sku)
          : item.sku,
      size:
        item.slotId === targetSlotId
          ? String(replacementVariant.size ?? "")
          : item.size,
      color:
        item.slotId === targetSlotId
          ? String(replacementVariant.color ?? "")
          : item.color,
      priceCents:
        item.slotId === targetSlotId
          ? Number(replacementVariant.price_cents)
          : item.priceCents,
      productSortOrder: item.productSortOrder,
      targetGender:
        item.slotId === targetSlotId
          ? (replacementVariant.target_gender ?? null)
          : item.targetGender,
    }));
    (report.evidence as JsonRecord).publishedDuringSale = await adminRequest(
      guestInput,
      token,
      "POST",
      `/machines/${machineId}/planogram-versions`,
      { planogramVersion: newPlanogramVersion, slots: payloadSlots },
    );

    const fenceDeadline = Date.now() + 8_000;
    do {
      const mid = (await daemonGet(handoff, "/v1/sale-view")) as JsonRecord;
      if (mid.planogramVersion === newPlanogramVersion) {
        throw new Error(
          "daemon adopted the new planogram while the sale was still active",
        );
      }
      await sleep(500);
    } while (Date.now() < fenceDeadline);

    await control(guestInput, `/v1/serial-sessions/${sessionId}/release-f0`);
    await control(guestInput, `/v1/serial-sessions/${sessionId}/wait-frame`, {
      parsedOpcode: "F2",
      timeoutMs: 30_000,
    });
    (report.evidence as JsonRecord).ui = await readUi(client).catch(
      (error) => ({
        error: String(error),
      }),
    );
    (report.evidence as JsonRecord).serial = await control(
      guestInput,
      `/v1/serial-sessions/${sessionId}/evidence`,
    ).catch((error) => ({ error: String(error) }));
    await waitForRoute(client, "#/result/success", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const adoptDeadline = Date.now() + 90_000;
    let saleViewAfter: JsonRecord | null = null;
    do {
      saleViewAfter = (await daemonGet(handoff, "/v1/sale-view")) as JsonRecord;
      if (saleViewAfter.planogramVersion === newPlanogramVersion) break;
      await sleep(1_000);
    } while (Date.now() < adoptDeadline);
    if (saleViewAfter?.planogramVersion !== newPlanogramVersion) {
      throw new Error(
        `daemon did not adopt the new planogram after the sale: ${String(saleViewAfter?.planogramVersion)}`,
      );
    }
    (report.evidence as JsonRecord).saleViewAfter = saleViewAfter;
    const finalReport = (await platform(
      guestInput,
      runId,
      machineCode,
      sessionId,
    )) as JsonRecord;
    const order = (rows(finalReport, "orders") as JsonRecord[]).find(
      (candidate) => candidate.id === sale.orderId,
    );
    if (String(order?.planogramVersion ?? "") !== oldPlanogramVersion) {
      throw new Error(
        `sale order did not retain the old planogram: ${String(order?.planogramVersion)}`,
      );
    }
    (report.evidence as JsonRecord).order = order;
    (report.evidence as JsonRecord).restore =
      await restoreBaselinePlanogramAndStock({
        guestInput,
        handoff,
        token,
        machineId,
        baselineSaleView: oldSaleView,
        fixtures:
          (guestInput.fixtureAllocation as JsonRecord | undefined) ?? {},
      });
    report.assertions = {
      daemonFencedDuringActiveSale: true,
      saleCompletedWithOldPlanogram: true,
      newPlanogramAdoptedAfterSale: true,
    };
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (session && !cleaned) {
      cleaned = true;
      if (guestInput) {
        await control(
          guestInput,
          `/v1/serial-sessions/${String(session.sessionId)}/abort`,
          {},
        ).catch(() => undefined);
      }
    }
    await client?.close().catch(() => undefined);
    writeJson(options.outPath, report);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSkuRaceGuest(parseSkuRaceGuestArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
