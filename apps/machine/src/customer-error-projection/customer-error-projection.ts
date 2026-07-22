export type CustomerErrorStage =
  | "payment_creation"
  | "order_reconciliation"
  | "product_refresh"
  | "device"
  | "dispense"
  | "refund"
  | "unknown";

export type CustomerErrorProjection = {
  stage: CustomerErrorStage;
  message: string;
};

const CUSTOMER_ERROR_COPY: Record<CustomerErrorStage, string> = {
  payment_creation: "支付订单创建失败，请稍后重试",
  order_reconciliation: "订单状态确认失败，请稍后重试",
  product_refresh: "商品信息更新失败，请重新选择商品",
  device: "设备暂不可用，请联系工作人员",
  dispense: "出货异常，请联系工作人员处理",
  refund: "退款状态确认失败，请联系工作人员处理",
  unknown: "操作未完成，请稍后重试",
};

// The operation error intentionally does not affect customer copy. Technical
// detail is recorded outside customer surfaces by the caller.
export function projectCustomerError(
  stage: CustomerErrorStage,
  _error?: unknown,
): CustomerErrorProjection {
  return { stage, message: CUSTOMER_ERROR_COPY[stage] };
}
