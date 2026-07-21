import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validatePngScreenshot } from "./machine-ui-cdp-driver.mjs";
import {
  MACHINE_UI_SCREENSHOT_SCENARIOS,
  parseScreenshotScenarioArgs,
  selectMachineUiScreenshotScenarios,
} from "./machine-ui-screenshot-scenarios.mjs";

describe("Machine UI screenshot scenarios", () => {
  it("covers customer, terminal, and every maintenance operation surface", () => {
    assert.ok(
      MACHINE_UI_SCREENSHOT_SCENARIOS.some((entry) => entry.name === "catalog"),
    );
    assert.ok(
      MACHINE_UI_SCREENSHOT_SCENARIOS.some(
        (entry) => entry.name === "result-failure",
      ),
    );
    assert.deepEqual(
      MACHINE_UI_SCREENSHOT_SCENARIOS.filter(
        (entry) => entry.maintenanceTask,
      ).map((entry) => entry.maintenanceTask),
      [
        "status",
        "commissioning",
        "hardware",
        "stock",
        "experience",
        "diagnostics",
      ],
    );
    assert.ok(
      MACHINE_UI_SCREENSHOT_SCENARIOS.every((entry) =>
        entry.route.startsWith("#/"),
      ),
    );
  });

  it("accepts repeated scenario flags but batches each name once", () => {
    assert.deepEqual(
      selectMachineUiScreenshotScenarios([
        "catalog",
        "catalog",
        "maintenance-status",
      ]).map((entry) => entry.name),
      ["catalog", "maintenance-status"],
    );
    assert.deepEqual(
      parseScreenshotScenarioArgs([
        "--scenario",
        "catalog",
        "--scenario",
        "payment",
        "--out",
        "/tmp/shots",
      ]).scenarios,
      ["catalog", "payment"],
    );
    assert.throws(
      () => selectMachineUiScreenshotScenarios(["unknown"]),
      /unknown machine UI screenshot scenario/,
    );
  });

  it("rejects unreadable and incorrectly sized PNG evidence", () => {
    assert.throws(
      () => validatePngScreenshot(Buffer.from("not-png")),
      /readable PNG/,
    );
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8);
    Buffer.from("IHDR").copy(png, 12);
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(100, 20);
    assert.throws(() => validatePngScreenshot(png), /1080x1920/);
  });
});
