import { describe, expect, it } from "vitest";

import { calendarContextForLocalDate } from "./natural-context-calendar";

describe("calendarContextForLocalDate", () => {
  it("recognizes same-day fixed-date festivals", () => {
    expect(calendarContextForLocalDate("2026-10-01")).toMatchObject({
      status: "ready",
      localDate: "2026-10-01",
      festivals: ["national_day"],
      primaryFestival: "national_day",
    });
  });

  it("recognizes same-day lunar festivals from platform-owned data", () => {
    expect(calendarContextForLocalDate("2026-02-17")).toMatchObject({
      festivals: ["spring_festival"],
      primaryFestival: "spring_festival",
    });
  });

  it("recognizes 24 solar terms independently of festivals", () => {
    expect(calendarContextForLocalDate("2026-12-22")).toMatchObject({
      festivals: [],
      primaryFestival: null,
      solarTerm: "winter_solstice",
    });
  });
});
