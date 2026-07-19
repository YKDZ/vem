import { setTimeout as sleep } from "node:timers/promises";

function saleStartOption(snapshot, optionKey) {
  const options = snapshot?.paymentOptions?.options;
  return Array.isArray(options)
    ? options.find((option) => option?.optionKey === optionKey)
    : null;
}

export async function waitForSaleStartCapability(
  daemonGet,
  { timeoutMs = 30_000, paymentOptionKey = "mock:mock" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await daemonGet("/v1/sale-start-capability").catch(() => null);
    const option = saleStartOption(last, paymentOptionKey);
    if (
      last?.canStartSale === true &&
      Number.isInteger(last?.revision) &&
      option?.ready === true &&
      option?.disabledReason === null
    ) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(
    `${paymentOptionKey} sale capability did not recover: ${JSON.stringify(last)}`,
  );
}
