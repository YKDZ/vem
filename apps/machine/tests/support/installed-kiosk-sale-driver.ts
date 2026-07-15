import type {
  InstalledKioskSaleCustomerPaymentSurface,
  InstalledKioskSaleDisturbance,
} from "@vem/shared";

export interface InstalledKioskSaleScenarioAdapter<Evidence = unknown> {
  startFromSaleableHome(): Promise<void>;
  selectProductAndQrPayment(): Promise<void>;
  assertPaymentQrPresented(): Promise<InstalledKioskSaleCustomerPaymentSurface>;
  injectDisturbance(disturbance: InstalledKioskSaleDisturbance): Promise<void>;
  completePayment(): Promise<void>;
  assertFulfillmentStarted(): Promise<void>;
  completeFulfillment(): Promise<void>;
  assertSuccessfulResult(): Promise<void>;
  readEvidence(): Promise<Evidence>;
}

export async function runInstalledKioskSaleScenario<Evidence>(
  adapter: InstalledKioskSaleScenarioAdapter<Evidence>,
  disturbance: InstalledKioskSaleDisturbance,
): Promise<Evidence> {
  await adapter.startFromSaleableHome();
  await adapter.selectProductAndQrPayment();
  await adapter.assertPaymentQrPresented();
  await adapter.injectDisturbance(disturbance);
  if (disturbance === "duplicate_payment_status") {
    await adapter.assertFulfillmentStarted();
    await adapter.completeFulfillment();
    await adapter.assertSuccessfulResult();
    return adapter.readEvidence();
  }
  await adapter.assertPaymentQrPresented();
  await adapter.completePayment();
  await adapter.assertFulfillmentStarted();
  await adapter.completeFulfillment();
  await adapter.assertSuccessfulResult();
  return adapter.readEvidence();
}
