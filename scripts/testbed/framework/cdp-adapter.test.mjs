import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertAdapterContract } from "./test-adapter.mjs";
import { CdpTestAdapter } from "./cdp-adapter.mjs";

describe("CDP test adapter", () => {
  it("implements the shared adapter contract", () => {
    const adapter = new CdpTestAdapter({ endpoint: "http://127.0.0.1:1" });
    assertAdapterContract(adapter);
    assert.equal(typeof adapter.connect, "function");
    assert.equal(typeof adapter.close, "function");
  });

  it("exposes only the try-on state file the slice driver reads", async () => {
    const adapter = new CdpTestAdapter();
    await assert.rejects(
      adapter.readFile("other.json"),
      /unknown adapter file/,
    );
  });
});
