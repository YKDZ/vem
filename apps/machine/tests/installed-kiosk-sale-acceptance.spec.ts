import { expect, test } from "@playwright/test";
import {
  browserInstalledKioskSaleContractFactsSchema,
  classifyBrowserInstalledKioskSaleContract,
  type InstalledKioskSaleDisturbance,
} from "@vem/shared";
import * as QRCode from "qrcode";

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

  test("rejects a QR payload replaced on the rendered customer surface", async ({
    page,
  }) => {
    const adapter = new PlaywrightInstalledKioskSaleAdapter(page);
    await adapter.startFromSaleableHome();
    await adapter.selectProductAndQrPayment();
    await adapter.assertPaymentQrPresented();

    const unrelatedPaymentUrl = "https://pay.example.test/unrelated-order";
    const unrelatedQrSvg = await QRCode.toString(unrelatedPaymentUrl, {
      type: "svg",
    });
    const unrelatedQrSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(unrelatedQrSvg)}`;
    await page.locator("[data-installed-kiosk-sale-qr]").evaluate(
      (element, replacement) => {
        element.setAttribute("src", replacement.source);
        element.setAttribute("data-qr-payload", replacement.paymentUrl);
      },
      {
        source: unrelatedQrSource,
        paymentUrl: unrelatedPaymentUrl,
      },
    );
    expect((await adapter.assertPaymentQrPresented()).paymentUrl).toBe(
      unrelatedPaymentUrl,
    );

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
    ).toEqual(
      expect.arrayContaining([
        "timeline_payment_qr_mismatch",
        "disturbance_barrier_payment_qr_mismatch",
      ]),
    );
  });
});
