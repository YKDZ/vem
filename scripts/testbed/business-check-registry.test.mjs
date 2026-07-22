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
        "sale",
        "scannerPayment",
        "visionExperience",
        "pickupProtocol",
        "behaviorAudio",
        "ipcRecovery",
        "fulfillmentRecovery",
        "paymentRecovery",
        "paymentProvider",
        "hardwareLifecycle",
        "localOperations",
        "environmentControl",
      ],
    );
    assert.deepEqual(
      BUSINESS_CHECK_REGISTRY.filter((descriptor) => descriptor.core).map(
        (descriptor) => descriptor.name,
      ),
      ["sale"],
    );
    assert.ok(
      BUSINESS_CHECK_REGISTRY.every((descriptor) => descriptor.fullRequired),
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
    const paymentProvider = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "paymentProvider",
    );
    assert.equal(
      paymentProvider?.runner?.script,
      "scripts/testbed/payment-provider-guest-full.mjs",
    );
    assert.equal(paymentProvider?.core, false);
    assert.equal(paymentProvider?.fullRequired, true);
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "localOperations",
      )?.runner?.script,
      "scripts/testbed/local-operations-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "behaviorAudio",
      )?.runner?.script,
      "scripts/testbed/behavior-audio-guest-full.mjs",
    );
    assert.equal(
      BUSINESS_CHECK_REGISTRY.find(
        (descriptor) => descriptor.name === "behaviorAudio",
      )?.fixtureKey,
      "sale",
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

  it("keeps the real payment-provider boundary out of warm fast runs while allowing focus", () => {
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast" }).map(
        (descriptor) => descriptor.name,
      ),
      ["sale"],
    );
    assert.deepEqual(
      selectBusinessChecks({ mode: "fast", focus: ["paymentProvider"] }).map(
        (descriptor) => descriptor.name,
      ),
      ["paymentProvider"],
    );
  });
});
