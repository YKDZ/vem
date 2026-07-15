import { describe, expect, it } from "vitest";

import { DaemonUnavailableError } from "./client";
import { isDefiniteStockMovementRejection } from "./stock-movement-retry";

describe("stock movement retry disposition", () => {
  it.each([
    [400, "stock_movement_record_failed"],
    [400, "machine_code_missing"],
    [403, "maintenance_session_invalid"],
    [422, "request_payload_invalid"],
  ])(
    "clears the pending fingerprint after definite HTTP %i rejection %s",
    (statusCode, responseCode) => {
      const error = new DaemonUnavailableError("request rejected", undefined, {
        statusCode,
        responseCode,
      });

      expect(isDefiniteStockMovementRejection(error)).toBe(true);
    },
  );

  it.each([
    ["network failure", new DaemonUnavailableError("daemon request failed")],
    [
      "HTTP request timeout",
      new DaemonUnavailableError("request timed out", undefined, {
        statusCode: 408,
        responseCode: "request_timeout",
      }),
    ],
    [
      "idempotency conflict",
      new DaemonUnavailableError("movement key conflict", undefined, {
        statusCode: 409,
        responseCode: "stock_movement_idempotency_conflict",
      }),
    ],
    [
      "possibly committed conflict",
      new DaemonUnavailableError("movement may exist", undefined, {
        statusCode: 409,
        responseCode: "stock_movement_already_recorded",
      }),
    ],
    [
      "HTTP 500",
      new DaemonUnavailableError("internal error", undefined, {
        statusCode: 500,
        responseCode: "stock_movement_record_failed",
      }),
    ],
    ["untyped failure", new Error("unknown result")],
  ])("keeps the pending fingerprint for %s", (_label, error) => {
    expect(isDefiniteStockMovementRejection(error)).toBe(false);
  });
});
