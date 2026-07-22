import { describe, expect, it } from "vitest";

import {
  isMutablePaymentExpiryInjectionStatus,
  parseInstalledKioskPaymentExpiryInjectionArgs,
} from "./inject-installed-kiosk-payment-expiry.cli";

describe("installed kiosk payment expiry injection", () => {
  it("accepts only an explicit expired-at testbed injection", () => {
    expect(
      parseInstalledKioskPaymentExpiryInjectionArgs(
        [
          "--run-id",
          "RUN-1",
          "--machine-code",
          "VEM-TESTBED-RUN-1",
          "--payment-id",
          "550e8400-e29b-41d4-a716-446655440001",
          "--expires-at",
          "2026-07-22T00:00:00.000Z",
        ],
        {
          VEM_INSTALLED_KIOSK_SALE_DATABASE_URL:
            "postgresql://vem:password@127.0.0.1:5432/vem",
        },
      ),
    ).toMatchObject({
      runId: "RUN-1",
      machineCode: "VEM-TESTBED-RUN-1",
      paymentId: "550e8400-e29b-41d4-a716-446655440001",
      expiresAt: new Date("2026-07-22T00:00:00.000Z"),
    });
  });

  it("never makes a succeeded payment eligible for expiry injection", () => {
    expect(isMutablePaymentExpiryInjectionStatus("pending")).toBe(true);
    expect(isMutablePaymentExpiryInjectionStatus("succeeded")).toBe(false);
  });

  it("rejects a non-testbed machine identity", () => {
    expect(() =>
      parseInstalledKioskPaymentExpiryInjectionArgs(
        [
          "--run-id",
          "RUN-1",
          "--machine-code",
          "VEM-WIN10-REAL-01",
          "--payment-id",
          "550e8400-e29b-41d4-a716-446655440001",
          "--expires-at",
          "2026-07-22T00:00:00.000Z",
        ],
        {
          VEM_INSTALLED_KIOSK_SALE_DATABASE_URL:
            "postgresql://vem:password@127.0.0.1:5432/vem",
        },
      ),
    ).toThrow("--machine-code must be a VEM-TESTBED-* identity");
  });
});
