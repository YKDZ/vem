import { describe, expect, it, vi } from "vitest";

import { post } from "@/api/request";

import {
  manualReconcile,
  queryPaymentCodeAttempt,
  queryRefund,
} from "./payments";

vi.mock("@/api/request", () => ({
  post: vi.fn().mockResolvedValue({}),
  get: vi.fn(),
  patch: vi.fn(),
}));

describe("payments api operator actions", () => {
  it("sends a reason when manually reconciling a payment", async () => {
    await manualReconcile(
      "550e8400-e29b-41d4-a716-446655440000",
      "customer sees paid but platform is pending",
    );

    expect(post).toHaveBeenCalledWith(
      "/payments/550e8400-e29b-41d4-a716-446655440000/reconcile",
      { reason: "customer sees paid but platform is pending" },
    );
  });

  it("sends a reason when querying a refund", async () => {
    await queryRefund(
      "550e8400-e29b-41d4-a716-446655440001",
      "customer requested refund status check",
    );

    expect(post).toHaveBeenCalledWith(
      "/payments/refunds/550e8400-e29b-41d4-a716-446655440001/query",
      { reason: "customer requested refund status check" },
    );
  });

  it("sends a reason when querying a payment-code attempt", async () => {
    await queryPaymentCodeAttempt(
      "550e8400-e29b-41d4-a716-446655440002",
      "customer app is still confirming",
    );

    expect(post).toHaveBeenCalledWith(
      "/payments/payment-code-attempts/550e8400-e29b-41d4-a716-446655440002/query",
      { reason: "customer app is still confirming" },
    );
  });
});
