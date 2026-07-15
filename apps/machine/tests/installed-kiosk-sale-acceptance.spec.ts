import { expect, test } from "@playwright/test";
import {
  browserInstalledKioskSaleContractFactsSchema,
  classifyBrowserInstalledKioskSaleContract,
  type InstalledKioskSaleDisturbance,
} from "@vem/shared";

import { renderPaymentQrDataUrl } from "../src/utils/payment-qr";
import { runInstalledKioskSaleScenario } from "./support/installed-kiosk-sale-driver";
import { PlaywrightInstalledKioskSaleAdapter } from "./support/playwright-installed-kiosk-sale-adapter";

const disturbances: ReadonlyArray<{
  disturbance: InstalledKioskSaleDisturbance;
  failureClaim: string;
}> = [
  {
    disturbance: "catalog_refresh",
    failureClaim: "catalog refresh cannot replace an active payment route",
  },
  {
    disturbance: "readiness_refresh",
    failureClaim: "readiness refresh cannot replace an active payment route",
  },
  {
    disturbance: "presence_departure",
    failureClaim: "presence departure cannot abandon an active payment route",
  },
  {
    disturbance: "duplicate_payment_status",
    failureClaim:
      "duplicate payment status cannot create a second command or stock movement",
  },
  {
    disturbance: "ipc_interruption",
    failureClaim:
      "a bounded IPC interruption cannot replace an active payment route",
  },
];

test.describe("Installed Kiosk Sale browser UI contract", () => {
  for (const { disturbance, failureClaim } of disturbances) {
    test(`${disturbance}: ${failureClaim}`, async ({ page }) => {
      const rawEvidence = await runInstalledKioskSaleScenario(
        new PlaywrightInstalledKioskSaleAdapter(page),
        disturbance,
      );
      const evidence =
        browserInstalledKioskSaleContractFactsSchema.parse(rawEvidence);

      if (disturbance === "duplicate_payment_status") {
        const record = evidence.transactions[0];
        expect(
          record.payment.statusDeliveries.map((delivery) => delivery.status),
        ).toEqual(["succeeded", "succeeded"]);
        expect(
          new Set(
            record.payment.statusDeliveries.map(
              (delivery) => delivery.deliveryId,
            ),
          ).size,
        ).toBe(1);
        expect(record.vendingCommand?.creationCount).toBe(1);
        expect(record.stockMovement?.creationCount).toBe(1);
      }

      expect(classifyBrowserInstalledKioskSaleContract(evidence)).toEqual({
        schemaVersion: "installed-kiosk-sale-ui-contract/v1",
        source: "browser_ui_contract",
        assertionScope: "ui_contract_only",
        status: "passed",
        diagnostics: [],
      });
    });
  }

  test("rejects an img src replaced on the rendered customer surface", async ({
    page,
  }) => {
    const adapter = new PlaywrightInstalledKioskSaleAdapter(page);
    await adapter.startFromSaleableHome();
    await adapter.selectProductAndQrPayment();
    await adapter.assertPaymentQrPresented();

    const unrelatedPaymentUrl = "https://pay.example.test/unrelated-order";
    const unrelatedQrSource = await renderPaymentQrDataUrl(unrelatedPaymentUrl);
    await page.locator("[data-installed-kiosk-sale-qr]").evaluate(
      (element, replacement) => {
        element.setAttribute("src", replacement.source);
      },
      {
        source: unrelatedQrSource,
      },
    );
    const replacedSurface = await adapter.assertPaymentQrPresented();
    expect(replacedSurface.paymentUrl).not.toBe(unrelatedPaymentUrl);
    expect(replacedSurface.renderedQrSource).toBe(unrelatedQrSource);

    await adapter.injectDisturbance("catalog_refresh");
    await adapter.assertPaymentQrPresented();
    await adapter.completePayment();
    await adapter.assertFulfillmentStarted();
    await adapter.completeFulfillment();
    await adapter.assertSuccessfulResult();

    const evidence = browserInstalledKioskSaleContractFactsSchema.parse(
      await adapter.readEvidence(),
    );
    expect(
      classifyBrowserInstalledKioskSaleContract(evidence).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(expect.arrayContaining(["rendered_payment_qr_source_mismatch"]));
  });
});
