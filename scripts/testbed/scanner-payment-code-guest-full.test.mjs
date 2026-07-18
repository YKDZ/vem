import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseScannerPaymentCodeGuestArgs } from "./scanner-payment-code-guest-full.mjs";

describe("scanner payment-code guest full", () => {
  it("parses the dedicated full-mode guest contract", () => {
    const options = parseScannerPaymentCodeGuestArgs([
      "--mode",
      "full",
      "--guest-input",
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      "--handoff",
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      "--out",
      "C:\\ProgramData\\VEM\\testbed\\scanner-payment-code.json",
    ]);

    assert.equal(options.mode, "full");
    assert.equal(
      options.outPath,
      "C:\\ProgramData\\VEM\\testbed\\scanner-payment-code.json",
    );
  });

  it("contains malformed, timeout, and valid scanner byte paths bound to daemon scanner event ids", () => {
    const source = readFileSync(
      new URL("./scanner-payment-code-guest-full.mjs", import.meta.url),
      "utf8",
    );

    assert.match(source, /buildInstalledKioskSaleScenarioSteps\("vm-scanner-payment-code"\)/);
    assert.match(source, /MALFORMED_SCANNER_BYTES/);
    assert.match(source, /TIMEOUT_PARTIAL_SCANNER_BYTES/);
    assert.match(source, /scannerCodeBase64/);
    assert.match(source, /scannerEventId/);
    assert.match(source, /\/v1\/serial-sessions\/.*\/wait-frame/);
  });
});
