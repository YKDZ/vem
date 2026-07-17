import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const forbidden = [
  "startNativeMqttRuntime",
  "createMachineMqttClient",
  "flushOutboxEvents",
  "listenPaymentCodeScanned",
  "startScanner",
  "scannerSelfCheck",
  "startVisionRuntime",
  "stopVisionRuntime",
  "exportLocalLogsZip",
  "getMachineRuntimeConfig",
  "requestMachineToken",
  "external-natural-environment",
  "External Natural Environment",
  "QWeather",
  "qweather",
  "@/hardware/adapter",
  "@/hardware/mock-adapter",
  "localOutbox",
];

const removedRuntimePaths = [
  "BringUpSnapshot",
  "/v1/bring-up",
  "simulated_hardware_ready",
  "maintenanceSession",
  "x-vem-maintenance-session",
  "beginMaintenanceSession",
  "maintenance-authorization",
  "ProtectedTouchKeyboard",
  "maintenance-session-route",
  "MachineProvisioningView",
  "native/scanner",
  "scanner_self_check",
  "start_scanner",
];

function transactionContractOffenders(source: string): string[] {
  const offenders: string[] = [];
  const transactionSchemaAlias = source.match(
    /\b(?:const|let|var)\s+transactionSnapshotSchema\s*=\s*([A-Za-z0-9_$]+)/,
  );
  const transactionTypeAlias = source.match(
    /\btype\s+TransactionSnapshot\s*=\s*([A-Za-z0-9_$]+)/,
  );
  if (/\bOmit\s*<\s*DaemonIpcTransactionSnapshot\b/.test(source)) {
    offenders.push("Omit<DaemonIpcTransactionSnapshot");
  }
  if (/\bPick\s*<\s*DaemonIpcTransactionSnapshot\b/.test(source)) {
    offenders.push("Pick<DaemonIpcTransactionSnapshot");
  }
  if (
    transactionSchemaAlias &&
    transactionSchemaAlias[1] !== "daemonIpcTransactionSnapshotSchema"
  ) {
    offenders.push("transactionSnapshotSchema");
  }
  if (
    transactionTypeAlias &&
    transactionTypeAlias[1] !== "DaemonIpcTransactionSnapshot"
  ) {
    offenders.push("TransactionSnapshot");
  }
  if (/\bTransactionSnapshotVendingSummary\b/.test(source)) {
    offenders.push("TransactionSnapshotVendingSummary");
  }
  if (/\bTransactionSnapshotPickupReminder\b/.test(source)) {
    offenders.push("TransactionSnapshotPickupReminder");
  }
  if (/\bTransactionSnapshotPaymentCodeAttempt\b/.test(source)) {
    offenders.push("TransactionSnapshotPaymentCodeAttempt");
  }
  if (/\btransactionSnapshotVendingSummarySchema\b/.test(source)) {
    offenders.push("transactionSnapshotVendingSummarySchema");
  }
  if (/\btransactionSnapshotPickupReminderSchema\b/.test(source)) {
    offenders.push("transactionSnapshotPickupReminderSchema");
  }
  if (/\btransactionSnapshotPaymentCodeAttemptSchema\b/.test(source)) {
    offenders.push("transactionSnapshotPaymentCodeAttemptSchema");
  }
  return offenders;
}

function scannerContractOffenders(source: string): string[] {
  const offenders: string[] = [];
  const scannerSchemaAlias = source.match(
    /\b(?:export\s+)?(?:const|let|var)\s+scannerStatusSchema\s*=\s*([^;]+);/s,
  );
  const scannerTypeAlias = source.match(
    /\b(?:export\s+)?type\s+ScannerStatus\s*=\s*([^;]+);/s,
  );
  if (/\bOmit\s*<\s*DaemonIpcScannerStatus\b/.test(source)) {
    offenders.push("Omit<DaemonIpcScannerStatus");
  }
  if (/\bPick\s*<\s*DaemonIpcScannerStatus\b/.test(source)) {
    offenders.push("Pick<DaemonIpcScannerStatus");
  }
  if (
    /\bdaemonIpcScannerStatusSchema\s*\.\s*(?:transform|extend|passthrough)\s*\(/.test(
      source,
    )
  ) {
    offenders.push("daemonIpcScannerStatusSchema mutation");
  }
  if (
    scannerSchemaAlias &&
    scannerSchemaAlias[1].replace(/\s+/g, "") !== "daemonIpcScannerStatusSchema"
  ) {
    offenders.push("scannerStatusSchema");
  }
  if (
    /\b(?:const|let|var)\s+[A-Za-z0-9_$]*[Ss]cannerStatus[A-Za-z0-9_$]*\s*=\s*z\s*\.\s*object\s*\(/.test(
      source,
    )
  ) {
    offenders.push("scanner status z.object");
  }
  if (/\binterface\s+ScannerStatus\b/.test(source)) {
    offenders.push("interface ScannerStatus");
  }
  const scannerTypeRhs = scannerTypeAlias?.[1].replace(/\s+/g, "");
  if (
    scannerTypeRhs &&
    scannerTypeRhs !== "z.infer<typeofscannerStatusSchema>" &&
    scannerTypeRhs !== "DaemonIpcScannerStatus"
  ) {
    offenders.push("ScannerStatus");
  }
  return offenders;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    if (!/\.(ts|vue)$/.test(path) || path.endsWith(".spec.ts")) return [];
    if (
      path.includes("/src/native/") ||
      path.includes("/src/mqtt/") ||
      path.includes("/src/local/") ||
      path.includes("/src/api/") ||
      path.endsWith("/src/components/MockHardwareControls.vue")
    ) {
      return [];
    }
    return [path];
  });
}

function allProductionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return allProductionSourceFiles(path);
    return /\.(ts|vue)$/.test(path) && !path.endsWith(".spec.ts")
      ? [path]
      : [];
  });
}

describe("machine-ui daemon migration guards", () => {
  it("does not reference old critical runtime APIs from production src", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const offenders = files(join(root, "src")).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return forbidden
        .filter((term) => content.includes(term))
        .map((term) => `${relative(root, file)}:${term}`);
    });

    expect(offenders).toEqual([]);
  });

  it("does not retain retired Bring-Up, PIN, or duplicate scanner paths in any production source root", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const offenders = allProductionSourceFiles(join(root, "src")).flatMap(
      (file) => {
        const content = readFileSync(file, "utf8");
        return removedRuntimePaths
          .filter((term) => content.includes(term))
          .map((term) => `${relative(root, file)}:${term}`);
      },
    );

    expect(offenders).toEqual([]);
  });

  it("does not keep machine-local vocabulary aliases for covered daemon IPC transaction payloads", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const schemas = readFileSync(join(root, "src/daemon/schemas.ts"), "utf8");

    expect(transactionContractOffenders(schemas)).toEqual([]);
  });

  it("does not keep machine-local vocabulary aliases for covered daemon IPC scanner payloads", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const schemas = readFileSync(join(root, "src/daemon/schemas.ts"), "utf8");

    expect(scannerContractOffenders(schemas)).toEqual([]);
  });

  it("detects common daemon IPC transaction contract bypass variants", () => {
    expect(
      transactionContractOffenders(`
        type LocalTransaction = Omit<DaemonIpcTransactionSnapshot, "vending">;
        type LocalTransactionPick = Pick< DaemonIpcTransactionSnapshot, "orderNo">;
        const transactionSnapshotSchema = z.object({});
        type TransactionSnapshotPickupReminder = { stage: string };
        const transactionSnapshotPaymentCodeAttemptSchema = z.object({});
      `),
    ).toEqual([
      "Omit<DaemonIpcTransactionSnapshot",
      "Pick<DaemonIpcTransactionSnapshot",
      "transactionSnapshotSchema",
      "TransactionSnapshotPickupReminder",
      "transactionSnapshotPaymentCodeAttemptSchema",
    ]);
  });

  it("detects common daemon IPC scanner contract bypass variants", () => {
    expect(
      scannerContractOffenders(`
        const scannerStatusSchema = daemonIpcScannerStatusSchema.transform((value) => value);
        const localScannerStatusSchema = z.object({ online: z.boolean() });
        interface ScannerStatus { online: boolean; code: string }
        type ScannerStatus = { online: boolean; code: string };
        type LocalScannerStatus = Pick<DaemonIpcScannerStatus, "online">;
      `),
    ).toEqual([
      "Pick<DaemonIpcScannerStatus",
      "daemonIpcScannerStatusSchema mutation",
      "scannerStatusSchema",
      "scanner status z.object",
      "interface ScannerStatus",
      "ScannerStatus",
    ]);
  });

  it("allows direct daemon IPC scanner contract aliases", () => {
    expect(
      scannerContractOffenders(`
        export const scannerStatusSchema = daemonIpcScannerStatusSchema;
        export type ScannerStatus = z.infer<typeof scannerStatusSchema>;
      `),
    ).toEqual([]);

    expect(
      scannerContractOffenders(`
        const scannerStatusSchema = daemonIpcScannerStatusSchema;
        type ScannerStatus = DaemonIpcScannerStatus;
      `),
    ).toEqual([]);
  });
});
