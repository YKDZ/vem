import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.mjs";

describe("runtime business-check registry", () => {
  it("owns the canonical target names and full-required default", () => {
    assert.deepEqual(
      BUSINESS_CHECK_REGISTRY.map((descriptor) => descriptor.name),
      [
        "commissioning",
        "startup",
        "sale",
        "scannerPayment",
        "visionExperience",
        "aiVirtualTryOn",
        "pickupProtocol",
        "presenceAndAudio",
        "ipcRecovery",
        "fulfillmentRecovery",
        "paymentRecovery",
        "paymentProvider",
        "stockMaintenance",
        "hardwareLifecycle",
        "localOperations",
        "environmentControl",
      ],
    );
    assert.deepEqual(
      BUSINESS_CHECK_REGISTRY.filter((descriptor) => descriptor.core).map(
        (descriptor) => descriptor.name,
      ),
      ["sale", "stockMaintenance"],
    );
    assert.deepEqual(
      BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.fullRequired,
      ).map((descriptor) => descriptor.name),
      [
        "commissioning",
        "startup",
        "sale",
        "scannerPayment",
        "visionExperience",
        "aiVirtualTryOn",
        "pickupProtocol",
        "presenceAndAudio",
        "ipcRecovery",
        "fulfillmentRecovery",
        "paymentRecovery",
        "stockMaintenance",
        "hardwareLifecycle",
        "localOperations",
        "environmentControl",
      ],
    );
    assert.ok(
      BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.name !== "paymentProvider",
      ).every((descriptor) => descriptor.fullRequired),
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "hardwareLifecycle",
      )?.runner?.script,
      "scripts/testbed/hardware-lifecycle-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "environmentControl",
      )?.runner?.script,
      "scripts/testbed/environment-control-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "paymentRecovery",
      )?.runner?.script,
      "scripts/testbed/payment-recovery-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "paymentRecovery",
      )?.allowActiveTransactionHandoff,
      true,
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "fulfillmentRecovery",
      )?.restoreFixtureStock,
      true,
    );
    const paymentProvider = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "paymentProvider",
    );
    assert.equal(
      paymentProvider?.runner?.script,
      "scripts/testbed/payment-provider-guest-full.mjs",
    );
    assert.equal(paymentProvider?.core, false);
    assert.equal(paymentProvider?.fullRequired, false);
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "localOperations",
      )?.runner?.script,
      "scripts/testbed/local-operations-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "presenceAndAudio",
      )?.runner?.script,
      "scripts/testbed/presence-and-audio-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "presenceAndAudio",
      )?.fixtureKey,
      "sale",
    );
  });

  it("registers AI virtual try-on as an independent focusable full track", () => {
    const track = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "aiVirtualTryOn",
    );
    assert.deepEqual(track?.runner, {
      kind: "powershell",
      script: "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
      args: [],
      reportFileName: "ai-virtual-try-on.json",
      artifactDirectory: "ai-virtual-try-on-artifacts",
    });
    assert.equal(track?.validator, "aiVirtualTryOn");
    assert.equal(track?.fixtureKey, "aiVirtualTryOn");
    assert.equal(track?.fullRequired, true);
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["aiVirtualTryOn"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["aiVirtualTryOn"],
    );
    assert.ok(
      selectBusinessChecks({ mode: "full" }).some(
        (descriptor) => descriptor.name === "aiVirtualTryOn",
      ),
    );
  });

  it("deduplicates focused fast selection in registry order and rejects it for full", () => {
    assert.deepEqual(
      selectBusinessChecks({
        mode: "fast",
        focus: ["ipcRecovery", "sale", "ipcRecovery"],
      }).map((descriptor) => descriptor.name),
      ["sale", "ipcRecovery"],
    );
    assert.throws(
      () => selectBusinessChecks({ mode: "fast", focus: ["oldScanner"] }),
      /unknown business check set: oldScanner/,
    );
    assert.throws(
      () => selectBusinessChecks({ mode: "full", focus: ["sale"] }),
      /--focus is only valid with --mode fast/,
    );
  });

  it("keeps installed startup ownership independently focusable and full-required", () => {
    const startup = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "startup",
    );
    assert.equal(
      startup?.runner?.script,
      "scripts/testbed/startup-owner-acceptance.mjs",
    );
    assert.equal(startup?.core, false);
    assert.equal(startup?.fullRequired, true);
    assert.deepEqual(startup?.evidence.passed, {
      trace: false,
      logs: false,
      screenshot: false,
    });
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["startup"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["startup"],
    );
  });

  it("keeps the real payment-provider boundary out of default selections while allowing fast focus", () => {
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast" }).map(
        (descriptor) => descriptor.name,
      ),
      ["sale", "stockMaintenance"],
    );
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["paymentProvider"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["paymentProvider"],
    );
    assert.ok(
      !selectBusinessChecks({ mode: "full" }).some(
        (descriptor) => descriptor.name === "paymentProvider",
      ),
    );
  });

  it("runs stock maintenance as a core, independently focusable business set", () => {
    const stockMaintenance = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "stockMaintenance",
    );
    assert.equal(
      stockMaintenance?.runner?.script,
      "scripts/testbed/stock-maintenance-guest-full.mjs",
    );
    assert.equal(stockMaintenance?.fixtureKey, "stockMaintenance");
    assert.equal(stockMaintenance?.core, true);
    assert.equal(stockMaintenance?.fullRequired, true);
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["stockMaintenance"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["stockMaintenance"],
    );
  });
});
