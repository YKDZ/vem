import type { MachineOrderStatusNextAction } from "@vem/shared";

import { describe, expect, it } from "vitest";

import { resultKindFromNextAction } from "./checkout";

describe("checkout state helpers", () => {
  it.each<[MachineOrderStatusNextAction, string | null]>([
    ["wait_payment", null],
    ["dispensing", null],
    ["success", "success"],
    ["payment_failed", "payment_failed"],
    ["payment_expired", "payment_expired"],
    ["dispense_failed", "dispense_failed"],
    ["refund_pending", "refund_pending"],
    ["refunded", "refunded"],
    ["manual_handling", "manual_handling"],
    ["closed", "closed"],
  ])("maps %s to result kind %s", (nextAction, expected) => {
    expect(resultKindFromNextAction(nextAction)).toBe(expected);
  });
});
