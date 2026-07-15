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

  test("captures a route flashed between Result observation and observation close", async ({
    page,
  }) => {
    const adapter = new PlaywrightInstalledKioskSaleAdapter(page);
    await adapter.startFromSaleableHome();
    await adapter.selectProductAndQrPayment();
    await adapter.assertPaymentQrPresented();
    await adapter.injectDisturbance("catalog_refresh");
    await adapter.assertPaymentQrPresented();
    await adapter.completePayment();
    await adapter.assertFulfillmentStarted();
    await adapter.completeFulfillment();

    await page.evaluate(() => {
      const control: unknown = Reflect.get(
        window,
        "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
      );
      if (typeof control !== "object" || control === null) {
        throw new Error("Installed Kiosk Sale debug control is unavailable");
      }
      const observeTransactionSurface: unknown = Reflect.get(
        control,
        "observeTransactionSurface",
      );
      const recordRouteObservation: unknown = Reflect.get(
        control,
        "recordRouteObservation",
      );
      if (
        typeof observeTransactionSurface !== "function" ||
        typeof recordRouteObservation !== "function"
      ) {
        throw new Error("Installed Kiosk Sale route flash hook is unavailable");
      }

      let resultObservationCount = 0;
      Reflect.set(control, "observeTransactionSurface", (surface: unknown) => {
        const result: unknown = Reflect.apply(
          observeTransactionSurface,
          control,
          [surface],
        );
        const route =
          typeof surface === "object" && surface !== null
            ? Reflect.get(surface, "route")
            : null;
        if (route === "result") {
          resultObservationCount += 1;
          if (resultObservationCount === 2) {
            Reflect.apply(recordRouteObservation, control, ["/catalog"]);
          }
        }
        return result;
      });
    });

    await adapter.assertSuccessfulResult();

    const evidence = browserInstalledKioskSaleContractFactsSchema.parse(
      await adapter.readEvidence(),
    );
    expect(evidence.timeline.map((entry) => entry.route)).toContain("home");
    expect(
      classifyBrowserInstalledKioskSaleContract(evidence).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("active_transaction_route_replaced");
  });

  test("rejects an img src replaced on the rendered customer surface", async ({
    page,
  }) => {
    const adapter = new PlaywrightInstalledKioskSaleAdapter(page);
    await adapter.startFromSaleableHome();
    await adapter.selectProductAndQrPayment();
    await adapter.assertPaymentQrPresented({ assertDecodedPayload: false });

    const unrelatedPaymentUrl = "https://pay.example.test/unrelated-order";
    const unrelatedQrSource = await QRCode.toDataURL(unrelatedPaymentUrl, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#020617", light: "#ffffff" },
    });
    await page.locator("[data-installed-kiosk-sale-qr]").evaluate(
      (element, replacement) => {
        element.setAttribute("src", replacement.source);
      },
      {
        source: unrelatedQrSource,
      },
    );
    const replacedSurface = await adapter.assertPaymentQrPresented({
      assertDecodedPayload: false,
    });
    expect(replacedSurface.paymentUrl).not.toBe(unrelatedPaymentUrl);
    expect(replacedSurface.decodedQrPayload).toBe(unrelatedPaymentUrl);

    await adapter.injectDisturbance("catalog_refresh");
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
