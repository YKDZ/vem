#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  adminToken,
  daemonGet,
  daemonPost,
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

const SCHEMA_VERSION = "vem-sku-stock-sync-guest-full/v1";

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

export function parseSkuStockSyncGuestArgs(args: string[]): {
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

async function saleViewQuantity(
  handoff: HandoffRecord,
  slotId: string,
): Promise<number> {
  const saleView = (await daemonGet(handoff, "/v1/sale-view")) as JsonRecord;
  const item = (saleView.items as JsonRecord[]).find(
    (candidate) => candidate.slotId === slotId,
  );
  return Number(item?.saleableStock ?? -1);
}

export async function runSkuStockSyncGuest(options: {
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
  try {
    const guestInput = readLocalJson(options.guestInputPath);
    const handoff = readLocalJson(options.handoffPath) as HandoffRecord;
    const runId = required(guestInput.runId, "runId");
    const machineCode = required(guestInput.machineCode, "machineCode");
    const fixture = (guestInput.fixtureAllocation as JsonRecord | undefined)?.[
      options.fixtureKey
    ] as JsonRecord | undefined;
    const slotId = required(fixture?.slotId, `${options.fixtureKey} slotId`);
    const baselineSaleView = (await daemonGet(
      handoff,
      "/v1/sale-view",
    )) as JsonRecord;
    const baselineReport = (await platform(
      guestInput,
      runId,
      machineCode,
      null,
    )) as JsonRecord;
    const inventory = (
      rows(baselineReport, "inventories") as JsonRecord[]
    ).find((candidate) => candidate.slotId === slotId);
    const inventoryId = required(inventory?.id, "fixture inventory id");
    const baselinePlatformQty = Number(inventory?.onHandQty ?? -1);
    const baselineMachineQty = await saleViewQuantity(handoff, slotId);
    (report.evidence as JsonRecord).baseline = {
      platformQty: baselinePlatformQty,
      machineQty: baselineMachineQty,
    };

    const token = await adminToken(guestInput);
    const adjust = (await adminRequest(
      guestInput,
      token,
      "POST",
      "/inventories/adjust",
      {
        inventoryId,
        deltaQty: 10,
        note: "sku-stock-sync platform->machine",
      },
    )) as JsonRecord;
    (report.evidence as JsonRecord).adjust = adjust;
    const machineDeadline = Date.now() + 60_000;
    let machineQtyAfterAdjust = -1;
    do {
      machineQtyAfterAdjust = await saleViewQuantity(handoff, slotId);
      if (machineQtyAfterAdjust === baselineMachineQty + 10) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < machineDeadline);
    if (machineQtyAfterAdjust !== baselineMachineQty + 10) {
      throw new Error(
        `machine sale-view did not adopt platform adjust: expected ${baselineMachineQty + 10}, saw ${machineQtyAfterAdjust}`,
      );
    }

    const refillTaskId = `sku-stock-sync-${Date.now()}`;
    const refill = (await daemonPost(handoff, "/v1/stock/maintenance-task", {
      taskId: refillTaskId,
      mode: "routine_refill",
      slots: [{ slotId, addition: 5 }],
    })) as JsonRecord;
    (report.evidence as JsonRecord).refill = refill;
    const platformDeadline = Date.now() + 60_000;
    let platformQtyAfterRefill = -1;
    do {
      const fresh = (await platform(
        guestInput,
        runId,
        machineCode,
        null,
      )) as JsonRecord;
      const freshInventory = (rows(fresh, "inventories") as JsonRecord[]).find(
        (candidate) => candidate.id === inventoryId,
      );
      platformQtyAfterRefill = Number(freshInventory?.onHandQty ?? -1);
      if (platformQtyAfterRefill === baselinePlatformQty + 10 + 5) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < platformDeadline);
    if (platformQtyAfterRefill !== baselinePlatformQty + 10 + 5) {
      throw new Error(
        `platform did not adopt machine refill: expected ${baselinePlatformQty + 15}, saw ${platformQtyAfterRefill}`,
      );
    }

    const machine = (rows(baselineReport, "machines") as JsonRecord[]).find(
      (candidate) => candidate.code === machineCode,
    );
    (report.evidence as JsonRecord).restore =
      await restoreBaselinePlanogramAndStock({
        guestInput,
        handoff,
        token,
        machineId: required(machine?.id, "machine id"),
        baselineSaleView,
        fixtures:
          (guestInput.fixtureAllocation as JsonRecord | undefined) ?? {},
      });

    report.assertions = {
      platformAdjustReachedMachine: true,
      machineRefillReachedPlatform: true,
    };
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeJson(options.outPath, report);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSkuStockSyncGuest(parseSkuStockSyncGuestArgs(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
