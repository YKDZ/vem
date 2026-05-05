import { describe, expect, it } from "vitest";

import { formatCents, formatDateTimeFromMs } from "./format";

describe("machine format utilities", () => {
  it("formats cents as CNY", () => {
    expect(formatCents(1299)).toBe("¥12.99");
    expect(formatCents(0)).toBe("¥0.00");
  });

  it("returns dash for missing timestamp", () => {
    expect(formatDateTimeFromMs(null)).toBe("-");
    expect(formatDateTimeFromMs(undefined)).toBe("-");
  });
});
