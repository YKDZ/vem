import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoPlatformPaymentSecretBytes } from "./build-factory-media.mjs";

describe("Factory runtime payment secret boundary", () => {
  it("accepts normal runtime bytes and rejects platform key/certificate PEM", () => {
    assert.doesNotThrow(() =>
      assertNoPlatformPaymentSecretBytes(
        Buffer.from("ordinary machine runtime"),
        "vem-machine-ui",
      ),
    );
    for (const bytes of [
      "-----BEGIN PRIVATE KEY-----\nplatform-key",
      "-----BEGIN RSA PRIVATE KEY-----\nplatform-key",
      "-----BEGIN CERTIFICATE-----\nplatform-payment-certificate",
    ]) {
      assert.throws(
        () =>
          assertNoPlatformPaymentSecretBytes(Buffer.from(bytes), "vem-daemon"),
        /platform payment private-key or certificate/i,
      );
    }
  });
});
