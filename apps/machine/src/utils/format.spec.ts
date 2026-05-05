import { describe, expect, it } from "vitest";

import {
  formatCents,
  formatCountdown,
  formatDateTimeFromMs,
  getRemainingSeconds,
} from "./format";

describe("machine format utilities", () => {
  it("formats cents as CNY", () => {
    expect(formatCents(1299)).toBe("¥12.99");
    expect(formatCents(0)).toBe("¥0.00");
  });

  it("returns dash for missing timestamp", () => {
    expect(formatDateTimeFromMs(null)).toBe("-");
    expect(formatDateTimeFromMs(undefined)).toBe("-");
  });

  it("calculates remaining seconds from ISO expiry", () => {
    expect(
      getRemainingSeconds(
        "2026-05-04T12:00:30.000Z",
        new Date("2026-05-04T12:00:00.000Z").getTime(),
      ),
    ).toBe(30);
    expect(
      getRemainingSeconds(
        "2026-05-04T12:00:00.000Z",
        new Date("2026-05-04T12:00:01.000Z").getTime(),
      ),
    ).toBe(0);
  });

  it("formats countdown as mm:ss", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(9)).toBe("00:09");
    expect(formatCountdown(125)).toBe("02:05");
  });
});
