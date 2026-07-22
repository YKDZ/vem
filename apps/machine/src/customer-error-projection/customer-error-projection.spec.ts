import { describe, expect, it } from "vitest";

import { projectCustomerError } from "./customer-error-projection";

describe("customer error projection", () => {
  it.each([
    ["payment_creation", "支付订单创建失败，请稍后重试"],
    ["order_reconciliation", "订单状态确认失败，请稍后重试"],
    ["product_refresh", "商品信息更新失败，请重新选择商品"],
    ["device", "设备暂不可用，请联系工作人员"],
    ["dispense", "出货异常，请联系工作人员处理"],
    ["refund", "退款状态确认失败，请联系工作人员处理"],
    ["unknown", "操作未完成，请稍后重试"],
  ] as const)("maps %s to stable customer copy", (stage, message) => {
    expect(
      projectCustomerError(stage, {
        message:
          "HTTP 502: provider MQTT IPC serial COM3 schema validation failed",
      }),
    ).toEqual({ stage, message });
  });

  it("uses the stage-generic copy for an unrecognised failure", () => {
    expect(
      projectCustomerError("payment_creation", new Error("provider declined")),
    ).toEqual({
      stage: "payment_creation",
      message: "支付订单创建失败，请稍后重试",
    });
  });
});
