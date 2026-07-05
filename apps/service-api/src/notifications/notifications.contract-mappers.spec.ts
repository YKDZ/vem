import { describe, expect, it } from "vitest";

import { mapNotificationReadToPatch } from "./notifications.contract-mappers";

describe("notifications contract mappers", () => {
  it("maps notification read handling into an explicit read patch", () => {
    const updatedAt = new Date("2026-07-05T00:00:00.000Z");

    expect(mapNotificationReadToPatch(updatedAt)).toEqual({
      status: "read",
      updatedAt,
    });
  });
});
