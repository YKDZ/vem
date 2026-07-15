import { expect, test, type Page } from "@playwright/test";
import {
  classifyInstalledKioskSaleAcceptance,
  installedKioskSaleAcceptanceFactsSchema,
  type InstalledKioskSaleDisturbance,
} from "@vem/shared";

import { getMachineRuntimeScenario } from "../src/dev/runtime-scenarios";
import { tapLocator } from "./support/touchscreen";
import { loadMachineRuntimeScenario } from "./support/ui-debug";

const readyCatalogScenario = getMachineRuntimeScenario("ready-catalog");
const timelineStorageKey = "vem.machine.installedKioskSale.timeline";

type Disturbance = Exclude<InstalledKioskSaleDisturbance, "none">;

const disturbances: ReadonlyArray<{
  disturbance: Disturbance;
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

async function installTimelineRecorder(page: Page): Promise<void> {
  await page.addInitScript((storageKey) => {
    const route = () => {
      const path = window.location.hash.replace(/^#/, "");
      if (path.startsWith("/catalog")) return "home";
      if (path.startsWith("/products")) return "product";
      if (path.startsWith("/checkout")) return "checkout";
      if (path.startsWith("/payment")) return "payment";
      if (path.startsWith("/dispensing")) return "fulfillment";
      if (path.startsWith("/result")) return "result";
      if (path.startsWith("/maintenance")) return "maintenance";
      if (path.startsWith("/offline")) return "offline";
      return "other";
    };
    const sample = () => {
      const stored = window.localStorage.getItem(
        "vem.machine.uiDebug.transaction",
      );
      let transactionId: string | null = null;
      try {
        const parsed = stored
          ? (JSON.parse(stored) as { orderId?: unknown })
          : null;
        transactionId =
          typeof parsed?.orderId === "string" ? parsed.orderId : null;
      } catch {
        transactionId = null;
      }
      const timeline = JSON.parse(
        window.sessionStorage.getItem(storageKey) ?? "[]",
      ) as unknown[];
      timeline.push({
        observedAt: new Date().toISOString(),
        route: route(),
        transactionId,
      });
      window.sessionStorage.setItem(storageKey, JSON.stringify(timeline));
    };
    sample();
    window.addEventListener("hashchange", sample);
    window.setInterval(sample, 25);
    Reflect.set(window, "__VEM_INSTALLED_KIOSK_SALE_SAMPLE__", sample);
  }, timelineStorageKey);
}

async function captureTimeline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sample = Reflect.get(
      window,
      "__VEM_INSTALLED_KIOSK_SALE_SAMPLE__",
    ) as (() => void) | undefined;
    sample?.();
  });
}

async function runCustomerSelection(page: Page): Promise<void> {
  await tapLocator(page, page.getByRole("button", { name: /T恤/ }));
  await tapLocator(
    page,
    page.getByRole("button", { name: /基础短袖/ }).first(),
  );
  await tapLocator(page, page.getByRole("button", { name: /立即购买 ¥59.00/ }));
  await expect(page).toHaveURL(/#\/checkout$/);

  await page.locator(".payment-option", { hasText: "支付宝扫码" }).click();
  await tapLocator(
    page,
    page.getByRole("button", { name: "确认并生成支付二维码" }),
  );
  await expect(page).toHaveURL(/#\/payment$/);
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible();
}

async function inject(page: Page, disturbance: Disturbance): Promise<void> {
  await page.evaluate(async (value) => {
    const control = Reflect.get(
      window,
      "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
    ) as { inject?: (kind: string) => Promise<void> } | undefined;
    if (!control?.inject) {
      throw new Error("Installed Kiosk Sale debug control is unavailable");
    }
    await control.inject(value);
  }, disturbance);
}

async function readFacts(
  page: Page,
  disturbance: Disturbance,
): Promise<unknown> {
  return page.evaluate(
    ({ storageKey, disturbance: injectedDisturbance }) => {
      const control = Reflect.get(
        window,
        "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
      ) as { readEvidence?: () => unknown } | undefined;
      if (!control?.readEvidence) {
        throw new Error("Installed Kiosk Sale evidence is unavailable");
      }
      return {
        ...control.readEvidence(),
        profile: "browser_fast_feedback",
        disturbance: injectedDisturbance,
        timeline: JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]"),
      };
    },
    { storageKey: timelineStorageKey, disturbance },
  );
}

test.describe("Installed Kiosk Sale Acceptance", () => {
  for (const { disturbance, failureClaim } of disturbances) {
    test(`${disturbance}: ${failureClaim}`, async ({ page }) => {
      await installTimelineRecorder(page);
      await loadMachineRuntimeScenario(page, readyCatalogScenario);
      await runCustomerSelection(page);
      await captureTimeline(page);

      await inject(page, disturbance);
      await expect(page).toHaveURL(/#\/payment$/);
      await expect(
        page.getByRole("heading", { name: "订单支付" }),
      ).toBeVisible();
      await captureTimeline(page);

      await page.evaluate(async () => {
        const control = Reflect.get(
          window,
          "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
        ) as { completePayment?: () => Promise<void> } | undefined;
        await control?.completePayment?.();
      });
      await expect(page).toHaveURL(/#\/dispensing$/);
      await captureTimeline(page);
      await page.evaluate(async () => {
        const control = Reflect.get(
          window,
          "__VEM_INSTALLED_KIOSK_SALE_DEBUG__",
        ) as { completeDispense?: () => Promise<void> } | undefined;
        await control?.completeDispense?.();
      });
      await expect(page).toHaveURL(/#\/result\/success$/);
      await captureTimeline(page);

      const facts = installedKioskSaleAcceptanceFactsSchema.parse(
        await readFacts(page, disturbance),
      );
      expect(classifyInstalledKioskSaleAcceptance(facts)).toMatchObject({
        status: "passed",
        diagnostics: [],
      });
    });
  }
});
