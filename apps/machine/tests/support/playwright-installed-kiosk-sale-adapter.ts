import type {
  InstalledKioskSaleCustomerPaymentSurface,
  InstalledKioskSaleCustomerTransactionSurface,
  InstalledKioskSaleDisturbance,
} from "@vem/shared";

import { expect, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import type { InstalledKioskSaleScenarioAdapter } from "./installed-kiosk-sale-driver";

import { getMachineRuntimeScenario } from "../../src/dev/runtime-scenarios";
import { tapLocator } from "./touchscreen";
import { loadMachineRuntimeScenario } from "./ui-debug";

const readyCatalogScenario = getMachineRuntimeScenario("ready-catalog");

export class PlaywrightInstalledKioskSaleAdapter implements InstalledKioskSaleScenarioAdapter {
  private paymentSurface: InstalledKioskSaleCustomerPaymentSurface | null =
    null;
  private closedEvidence: unknown = null;

  constructor(private readonly page: Page) {}

  async startFromSaleableHome(): Promise<void> {
    await loadMachineRuntimeScenario(this.page, readyCatalogScenario);
  }

  async selectProductAndQrPayment(): Promise<void> {
    await tapLocator(this.page, this.page.getByRole("button", { name: /T恤/ }));
    await tapLocator(
      this.page,
      this.page.getByRole("button", { name: /基础短袖/ }).first(),
    );
    await tapLocator(
      this.page,
      this.page.getByRole("button", { name: /立即购买 ¥59.00/ }),
    );
    await expect(this.page).toHaveURL(/#\/checkout$/);
    await this.page
      .locator(".payment-option", { hasText: "支付宝扫码" })
      .click();
    await tapLocator(
      this.page,
      this.page.getByRole("button", { name: "确认并生成支付二维码" }),
    );
  }

  async assertPaymentQrPresented(
    options: { assertDecodedPayload?: boolean } = {},
  ): Promise<InstalledKioskSaleCustomerPaymentSurface> {
    await expect(this.page).toHaveURL(/#\/payment$/);
    await expect(
      this.page.getByRole("heading", { name: "订单支付" }),
    ).toBeVisible();
    await expect(
      this.page.locator("[data-installed-kiosk-sale-qr]"),
    ).toBeVisible();
    const qr = this.page.locator("[data-installed-kiosk-sale-qr]");
    await expect
      .poll(async () =>
        qr.evaluate((element) => {
          if (!(element instanceof HTMLImageElement)) return false;
          return (
            element.complete &&
            element.naturalWidth > 0 &&
            element.naturalHeight > 0
          );
        }),
      )
      .toBe(true);
    const surface = await this.page
      .locator("[data-installed-kiosk-sale-payment-surface]")
      .evaluate((element) => {
        const qr = element.querySelector("[data-installed-kiosk-sale-qr]");
        return {
          observedAt: new Date().toISOString(),
          orderId: element.getAttribute("data-order-id"),
          paymentId: element.getAttribute("data-payment-id"),
          transactionId: element.getAttribute("data-transaction-id"),
          paymentUrl: element.getAttribute("data-payment-url"),
          renderedQrSource: qr?.getAttribute("src") ?? null,
        };
      });
    if (
      !surface.orderId ||
      !surface.paymentId ||
      !surface.transactionId ||
      !surface.paymentUrl ||
      !surface.renderedQrSource ||
      !URL.canParse(surface.paymentUrl)
    ) {
      throw new Error("Rendered customer payment identity is incomplete");
    }
    const observedSurface: InstalledKioskSaleCustomerPaymentSurface = {
      observedAt: surface.observedAt,
      orderId: surface.orderId,
      paymentId: surface.paymentId,
      transactionId: surface.transactionId,
      paymentUrl: surface.paymentUrl,
      renderedQrSource: surface.renderedQrSource,
      decodedQrPayload: decodeRenderedPaymentQr(surface.renderedQrSource),
    };
    if (
      options.assertDecodedPayload !== false &&
      observedSurface.decodedQrPayload !== observedSurface.paymentUrl
    ) {
      throw new Error("Rendered payment QR does not decode to the payment URL");
    }
    await this.control("observePaymentSurface", observedSurface);
    this.paymentSurface = observedSurface;
    return observedSurface;
  }

  async injectDisturbance(
    disturbance: InstalledKioskSaleDisturbance,
  ): Promise<void> {
    await this.control("inject", disturbance);
  }

  async completePayment(): Promise<void> {
    await this.control("completePayment");
  }

  async assertFulfillmentStarted(): Promise<void> {
    await expect(this.page).toHaveURL(/#\/dispensing$/);
    await this.observeTransactionSurface(
      "[data-installed-kiosk-sale-fulfillment-surface]",
      "fulfillment",
    );
  }

  async completeFulfillment(): Promise<void> {
    await this.control("completeDispense");
  }

  async assertSuccessfulResult(): Promise<void> {
    await expect(this.page).toHaveURL(/#\/result\/success$/);
    await this.observeTransactionSurface(
      "[data-installed-kiosk-sale-result-surface]",
      "result",
    );
    await this.page.waitForTimeout(125);
    await this.observeTransactionSurface(
      "[data-installed-kiosk-sale-result-surface]",
      "result",
    );
    this.closedEvidence = await this.closeObservationWindowAndReadEvidence();
  }

  async readEvidence(): Promise<unknown> {
    if (this.closedEvidence !== null) {
      return this.closedEvidence;
    }
    return this.page.evaluate((): unknown => {
      const control: unknown = Reflect.get(
        window,
        "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
      );
      if (typeof control !== "object" || control === null) {
        throw new Error("Installed Kiosk Sale evidence is unavailable");
      }
      const readEvidence: unknown = Reflect.get(control, "readEvidence");
      if (typeof readEvidence !== "function") {
        throw new Error("Installed Kiosk Sale evidence is unavailable");
      }
      const result: unknown = Reflect.apply(readEvidence, control, []);
      return result;
    });
  }

  private async control(
    action: "completePayment" | "completeDispense",
  ): Promise<void>;
  private async control(
    action: "inject",
    disturbance: InstalledKioskSaleDisturbance,
  ): Promise<void>;
  private async control(
    action: "observePaymentSurface",
    surface: InstalledKioskSaleCustomerPaymentSurface,
  ): Promise<void>;
  private async control(
    action: "observeTransactionSurface",
    surface: InstalledKioskSaleCustomerTransactionSurface,
  ): Promise<void>;
  private async control(
    action:
      | "completePayment"
      | "completeDispense"
      | "inject"
      | "observePaymentSurface"
      | "observeTransactionSurface",
    argument?: unknown,
  ): Promise<void> {
    await this.page.evaluate(
      async ({ action: requestedAction, argument: requestedArgument }) => {
        const control: unknown = Reflect.get(
          window,
          "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
        );
        if (typeof control !== "object" || control === null) {
          throw new Error("Installed Kiosk Sale debug control is unavailable");
        }
        const method: unknown = Reflect.get(control, requestedAction);
        if (typeof method !== "function") {
          throw new Error(
            `Installed Kiosk Sale ${requestedAction} is unavailable`,
          );
        }
        const args = requestedArgument === undefined ? [] : [requestedArgument];
        const result: unknown = Reflect.apply(method, control, args);
        await Promise.resolve(result);
      },
      { action, argument },
    );
  }

  private async closeObservationWindowAndReadEvidence(): Promise<unknown> {
    return this.page.evaluate((): unknown => {
      const control: unknown = Reflect.get(
        window,
        "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
      );
      if (typeof control !== "object" || control === null) {
        throw new Error("Installed Kiosk Sale debug control is unavailable");
      }
      const closeObservationWindow: unknown = Reflect.get(
        control,
        "closeObservationWindow",
      );
      if (typeof closeObservationWindow !== "function") {
        throw new Error(
          "Installed Kiosk Sale closeObservationWindow is unavailable",
        );
      }
      const result: unknown = Reflect.apply(
        closeObservationWindow,
        control,
        [],
      );
      return result;
    });
  }

  private async observeTransactionSurface(
    selector: string,
    route: InstalledKioskSaleCustomerTransactionSurface["route"],
  ): Promise<InstalledKioskSaleCustomerTransactionSurface> {
    const surface = await this.page.locator(selector).evaluate(
      (element, route) => ({
        observedAt: new Date().toISOString(),
        route,
        orderId: element.getAttribute("data-order-id"),
        paymentId: element.getAttribute("data-payment-id"),
        transactionId: element.getAttribute("data-transaction-id"),
        paymentUrl: element.getAttribute("data-payment-url"),
        commandId: element.getAttribute("data-command-id"),
      }),
      route,
    );
    if (
      !surface.orderId ||
      !surface.paymentId ||
      !surface.transactionId ||
      !surface.paymentUrl ||
      !surface.commandId ||
      !URL.canParse(surface.paymentUrl)
    ) {
      throw new Error(`Rendered ${route} identity is incomplete`);
    }
    const observedSurface: InstalledKioskSaleCustomerTransactionSurface =
      surface;
    if (!this.paymentSurface) {
      throw new Error(
        "Payment surface must be observed before transaction progress",
      );
    }
    expect(observedSurface).toMatchObject({
      orderId: this.paymentSurface.orderId,
      paymentId: this.paymentSurface.paymentId,
      transactionId: this.paymentSurface.transactionId,
      paymentUrl: this.paymentSurface.paymentUrl,
    });
    await this.control("observeTransactionSurface", observedSurface);
    return observedSurface;
  }
}

function decodeRenderedPaymentQr(source: string): string {
  const encoded = source.match(/^data:image\/png;base64,(.+)$/)?.[1];
  if (!encoded) {
    throw new Error("Rendered payment QR is not a PNG data URL");
  }
  const png = PNG.sync.read(Buffer.from(encoded, "base64"));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded) {
    throw new Error("Rendered payment QR could not be decoded");
  }
  return decoded.data;
}
