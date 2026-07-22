// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";

const { recordCustomerErrorEvidenceMock, renderPaymentQrDataUrlMock } =
  vi.hoisted(() => ({
    recordCustomerErrorEvidenceMock: vi.fn(),
    renderPaymentQrDataUrlMock: vi.fn(),
  }));

vi.mock("@/runtime/customer-error-evidence", () => ({
  recordCustomerErrorEvidence: recordCustomerErrorEvidenceMock,
}));

vi.mock("@/utils/payment-qr", () => ({
  renderPaymentQrDataUrl: renderPaymentQrDataUrlMock,
}));

import PaymentQrCode from "./PaymentQrCode.vue";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let mountedApp: App<Element> | null = null;
let mountedHost: HTMLElement | null = null;

afterEach(() => {
  mountedApp?.unmount();
  mountedHost?.remove();
  mountedApp = null;
  mountedHost = null;
  vi.clearAllMocks();
});

async function flushPromises(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
  await nextTick();
}

describe("PaymentQrCode", () => {
  it("ignores a stale QR render rejection instead of clearing or mis-correlating the current payment", async () => {
    const oldRender = deferred<string>();
    renderPaymentQrDataUrlMock
      .mockImplementationOnce(() => oldRender.promise)
      .mockResolvedValueOnce("data:image/png;base64,new-qr");
    const props = reactive({
      value: "https://pay.example/old",
      checkoutAttemptIdempotencyKey: "checkout:old",
      orderId: "order-old",
      paymentId: "payment-old",
      orderNo: "ORDER-OLD",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedApp = createApp({
      setup: () => () => h(PaymentQrCode, props),
    });
    mountedApp.mount(host);
    await flushPromises();

    props.value = "https://pay.example/new";
    props.checkoutAttemptIdempotencyKey = "checkout:new";
    props.orderId = "order-new";
    props.paymentId = "payment-new";
    props.orderNo = "ORDER-NEW";
    await flushPromises();

    expect(renderPaymentQrDataUrlMock).toHaveBeenNthCalledWith(
      2,
      "https://pay.example/new",
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,new-qr",
    );

    oldRender.reject(new Error("old QR renderer failed"));
    await flushPromises();

    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,new-qr",
    );
    expect(recordCustomerErrorEvidenceMock).not.toHaveBeenCalled();
  });
});
