import { describe, expect, it } from "vitest";

import {
  shouldShowAdvancedMaintenanceConfig,
  shouldShowMockPaymentControls,
} from "./runtime-flags";

describe("shouldShowMockPaymentControls", () => {
  it("returns true only when dev=true, paymentMethod=mock, flag=true", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "mock",
        flag: true,
      }),
    ).toBe(true);
  });

  it("returns true when flag is the string 'true'", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "mock",
        flag: "true",
      }),
    ).toBe(true);
  });

  it("returns false when dev=false", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: false,
        paymentMethod: "mock",
        flag: true,
      }),
    ).toBe(false);
  });

  it("returns false when paymentMethod is not mock", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "wechat",
        flag: true,
      }),
    ).toBe(false);
  });

  it("returns false when paymentMethod is qr_code (real payment)", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "qr_code",
        flag: true,
      }),
    ).toBe(false);
  });

  it("returns false when paymentMethod is null", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: null,
        flag: true,
      }),
    ).toBe(false);
  });

  it("returns false when flag is undefined", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "mock",
        flag: undefined,
      }),
    ).toBe(false);
  });

  it("returns false when flag is 'false'", () => {
    expect(
      shouldShowMockPaymentControls({
        dev: true,
        paymentMethod: "mock",
        flag: "false",
      }),
    ).toBe(false);
  });
});

describe("shouldShowAdvancedMaintenanceConfig", () => {
  it("is disabled by default", () => {
    expect(shouldShowAdvancedMaintenanceConfig({ flag: undefined })).toBe(
      false,
    );
  });

  it("is enabled only by an explicit true flag", () => {
    expect(shouldShowAdvancedMaintenanceConfig({ flag: true })).toBe(true);
    expect(shouldShowAdvancedMaintenanceConfig({ flag: "true" })).toBe(true);
    expect(shouldShowAdvancedMaintenanceConfig({ flag: false })).toBe(false);
    expect(shouldShowAdvancedMaintenanceConfig({ flag: "false" })).toBe(false);
  });
});
