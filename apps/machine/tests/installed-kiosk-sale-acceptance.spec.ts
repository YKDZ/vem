import { expect, test } from "@playwright/test";
import {
  browserInstalledKioskSaleContractFactsSchema,
  classifyBrowserInstalledKioskSaleContract,
  type InstalledKioskSaleDisturbance,
} from "@vem/shared";

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

      expect(classifyBrowserInstalledKioskSaleContract(evidence)).toEqual({
        schemaVersion: "installed-kiosk-sale-ui-contract/v1",
        source: "browser_ui_contract",
        assertionScope: "ui_contract_only",
        status: "passed",
        diagnostics: [],
      });
    });
  }
});
