import type {
  InstalledKioskSaleCustomerPaymentSurface,
  InstalledKioskSaleDisturbance,
} from "@vem/shared";

import { expect, type Page } from "@playwright/test";

import type { InstalledKioskSaleScenarioAdapter } from "./installed-kiosk-sale-driver";

import { getMachineRuntimeScenario } from "../../src/dev/runtime-scenarios";
import { tapLocator } from "./touchscreen";
import { loadMachineRuntimeScenario } from "./ui-debug";

const readyCatalogScenario = getMachineRuntimeScenario("ready-catalog");

export class PlaywrightInstalledKioskSaleAdapter implements InstalledKioskSaleScenarioAdapter {
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

  async assertPaymentQrPresented(): Promise<InstalledKioskSaleCustomerPaymentSurface> {
    await expect(this.page).toHaveURL(/#\/payment$/);
    await expect(
      this.page.getByRole("heading", { name: "订单支付" }),
    ).toBeVisible();
    await expect(
      this.page.locator("[data-installed-kiosk-sale-qr]"),
    ).toBeVisible();
    const surface = await this.page
      .locator("[data-installed-kiosk-sale-payment-surface]")
      .evaluate((element) => {
        const qr = element.querySelector("[data-installed-kiosk-sale-qr]");
        return {
          observedAt: new Date().toISOString(),
          orderId: element.getAttribute("data-order-id"),
          paymentId: element.getAttribute("data-payment-id"),
          paymentUrl: qr?.getAttribute("data-qr-payload") ?? null,
        };
      });
    if (
      !surface.orderId ||
      !surface.paymentId ||
      !surface.paymentUrl ||
      !URL.canParse(surface.paymentUrl)
    ) {
      throw new Error("Rendered customer payment identity is incomplete");
    }
    const observedSurface = {
      observedAt: surface.observedAt,
      orderId: surface.orderId,
      paymentId: surface.paymentId,
      paymentUrl: surface.paymentUrl,
    };
    await this.control("observePaymentSurface", observedSurface);
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
  }

  async completeFulfillment(): Promise<void> {
    await this.control("completeDispense");
  }

  async assertSuccessfulResult(): Promise<void> {
    await expect(this.page).toHaveURL(/#\/result\/success$/);
  }

  async readEvidence(): Promise<unknown> {
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
    action:
      | "completePayment"
      | "completeDispense"
      | "inject"
      | "observePaymentSurface",
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
}
