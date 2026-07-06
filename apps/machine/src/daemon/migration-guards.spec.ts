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

  it("does not keep machine-local vocabulary aliases for covered daemon IPC transaction payloads", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const schemas = readFileSync(join(root, "src/daemon/schemas.ts"), "utf8");

    expect(transactionContractOffenders(schemas)).toEqual([]);
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
});
