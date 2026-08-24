import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.ts";

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
        "implicitRecommendation",
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
      ["sale", "implicitRecommendation", "stockMaintenance"],
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
        "implicitRecommendation",
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
      "scripts/testbed/hardware-lifecycle-guest-full.ts",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "environmentControl",
      )?.runner?.script,
      "scripts/testbed/environment-control-guest-full.ts",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "paymentRecovery",
      )?.runner?.script,
      "scripts/testbed/payment-recovery-guest-full.ts",
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
      "scripts/testbed/payment-provider-guest-full.ts",
    );
    assert.equal(paymentProvider?.core, false);
    assert.equal(paymentProvider?.fullRequired, false);
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "localOperations",
      )?.runner?.script,
      "scripts/testbed/local-operations-guest-full.ts",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "presenceAndAudio",
      )?.runner?.script,
      "scripts/testbed/presence-and-audio-guest-full.ts",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "presenceAndAudio",
      )?.fixtureKey,
      "sale",
    );
  });

  it("deduplicates focused selection in registry order for fast and full", () => {
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
    assert.deepEqual(
      selectBusinessChecks({ mode: "full", focus: ["startup"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["startup"],
    );
  });

  it("keeps installed startup ownership independently focusable and full-required", () => {
    const startup = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "startup",
    );
    assert.equal(
      startup?.runner?.script,
      "scripts/testbed/startup-owner-acceptance.ts",
    );
    assert.equal(startup?.core, false);
    assert.equal(startup?.fullRequired, true);
    assert.deepEqual(startup?.evidence?.passed, {
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
    assert.deepEqual(
      selectBusinessChecks({ mode: "full", focus: ["startup"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["startup"],
    );
  });

  it("keeps the single-path Vision runner as the full installed check", () => {
    const visionExperience = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "visionExperience",
    );
    assert.equal(
      visionExperience?.runner?.script,
      "scripts/testbed/framework/slices/vision-experience/vision-experience-runner.ts",
    );
    assert.equal(
      visionExperience?.runner?.artifactDirectory,
      "vision-experience-artifacts",
    );
    assert.equal(visionExperience?.validator, "visionExperience");
    assert.equal(visionExperience?.fullRequired, true);
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["visionExperience"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["visionExperience"],
    );
  });

  it("runs implicit recommendation as an independent full-required core set", () => {
    const recommendation = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "implicitRecommendation",
    );
    assert.equal(
      recommendation?.runner?.script,
      "scripts/testbed/framework/slices/implicit-recommendation/implicit-recommendation-runner.ts",
    );
    assert.equal(
      recommendation?.runner?.artifactDirectory,
      "implicit-recommendation-artifacts",
    );
    assert.equal(recommendation?.validator, "implicitRecommendation");
    assert.equal(recommendation?.core, true);
    assert.equal(recommendation?.fullRequired, true);
    assert.deepEqual(
      selectBusinessChecks({
        mode: "fast",
        focus: ["implicitRecommendation"],
      }).map((descriptor) => descriptor.name),
      ["implicitRecommendation"],
    );
  });

  it("keeps the real payment-provider boundary out of default selections while allowing fast focus", () => {
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast" }).map(
        (descriptor) => descriptor.name,
      ),
      ["sale", "implicitRecommendation", "stockMaintenance"],
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
      "scripts/testbed/stock-maintenance-guest-full.ts",
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
