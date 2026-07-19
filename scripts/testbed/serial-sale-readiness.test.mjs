import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { waitForSaleStartCapability } from "./serial-sale-readiness.mjs";

describe("serial sale readiness helper", () => {
  it("waits for the configured payment option to be startable", async () => {
    const responses = [
      { canStartSale: false, revision: null },
      {
        canStartSale: true,
        revision: 2,
        paymentOptions: { options: [{ optionKey: "mock:mock", ready: true }] },
      },
      {
        canStartSale: true,
        revision: 3,
        paymentOptions: {
          options: [
            { optionKey: "mock:mock", ready: true, disabledReason: null },
          ],
        },
      },
    ];
    const snapshot = await waitForSaleStartCapability(
      async (path) => {
        if (path !== "/v1/sale-start-capability")
          throw new Error(`unexpected path ${path}`);
        return responses.shift();
      },
      { timeoutMs: 5_000, paymentOptionKey: "mock:mock" },
    );
    assert.equal(snapshot?.revision, 3);
    assert.equal(snapshot?.canStartSale, true);
  });

  it("throws when sale capability does not recover", async () => {
    await assert.rejects(
      waitForSaleStartCapability(
        async () => ({
          canStartSale: true,
          revision: 1,
          paymentOptions: {
            options: [
              { optionKey: "mock:mock", ready: false, disabledReason: "x" },
            ],
          },
        }),
        { timeoutMs: 200, paymentOptionKey: "mock:mock" },
      ),
      /mock:mock sale capability did not recover/,
    );
  });
});
