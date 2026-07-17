import { beforeEach, describe, expect, it } from "vitest";

import { daemonClient } from "@/daemon/client";

import {
  hasStoredUiDebugTransaction,
  installUiDebugDaemon,
  resetUiDebugTransaction,
} from "./ui-debug-daemon";

const UI_DEBUG_TRANSACTION_STORAGE_KEY = "vem.machine.uiDebug.transaction";

class FakeStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const localStorage = new FakeStorage();

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  resetUiDebugTransaction();
});

describe("ui debug daemon", () => {
  it("drops stale stored transactions that no longer match the daemon IPC schema", async () => {
    localStorage.setItem(
      UI_DEBUG_TRANSACTION_STORAGE_KEY,
      JSON.stringify({
        orderId: "550e8400-e29b-41d4-a716-446655440901",
        orderNo: "STALE-ORDER",
        productSummary: { name: "stale item" },
        paymentNo: "STALE-PAY",
        paymentMethod: "qr_code",
        paymentProvider: "alipay",
        paymentUrl: "https://pay.example.test/stale",
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        totalAmountCents: 6900,
        vending: {
          commandNo: "STALE-CMD",
          status: "succeeded",
          lastError: null,
          pickupReminder: {
            stage: "reset_completed",
            level: "info",
            message: "legacy reset completed reminder",
            warningNo: null,
            reportedAt: "2026-06-14T08:00:00.000Z",
          },
        },
        nextAction: "success",
        maskedAuthCode: null,
        paymentCodeAttempt: null,
        expiresAt: null,
        errorCode: null,
        errorMessage: null,
        operatorHint: null,
        updatedAt: "2026-06-14T08:00:00.000Z",
      }),
    );

    installUiDebugDaemon();

    await expect(daemonClient.getCurrentTransaction()).resolves.toMatchObject({
      orderNo: null,
      nextAction: null,
    });
    expect(hasStoredUiDebugTransaction()).toBe(false);
    expect(localStorage.getItem(UI_DEBUG_TRANSACTION_STORAGE_KEY)).toBeNull();
  });

  it("uses direct provisioning intents for interactive UI fixtures", async () => {
    installUiDebugDaemon();

    await expect(
      daemonClient.claimMachine("UI-DEBUG-CLAIM"),
    ).resolves.toMatchObject({
      status: "provisioned",
    });
  });
});
