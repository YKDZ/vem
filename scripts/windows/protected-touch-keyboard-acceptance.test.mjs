import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Windows touch-keyboard acceptance plan binds the interactive kiosk and protected routes", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/accept-protected-touch-keyboard.ps1",
      "-PrintPlan",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(
    plan.schemaVersion,
    "protected-touch-keyboard-acceptance-plan/v1",
  );
  assert.equal(plan.requiredSessionUser, "VEMKiosk");
  assert.deepEqual(plan.allowedRoutes, ["bring-up", "maintenance"]);
  assert.deepEqual(plan.deniedRoutes, [
    "boot",
    "catalog",
    "checkout",
    "payment",
    "dispensing",
    "result",
  ]);
  assert.deepEqual(
    plan.observations.map((observation) => observation.code),
    [
      "bring_up_touch_entry",
      "bring_up_native_submit",
      "maintenance_unauthorized_denied",
      "maintenance_authorized_touch_entry",
      "customer_route_denied",
      "physical_keyboard_preserved",
    ],
  );
});
