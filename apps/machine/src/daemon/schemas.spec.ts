import { describe, expect, it } from "vitest";

import { daemonEventSchema } from "./schemas";

describe("daemon schemas", () => {
  it("parses scanner event and keeps masked code only", () => {
    const fixture = {
      type: "scanner_code",
      eventId: "evt-1",
      maskedCode: "6212****9012",
      scannedAtMs: 1700000000000,
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const parsed = daemonEventSchema.parse(fixture as never);
    expect(parsed.type).toBe("scanner_code");
    if (parsed.type !== "scanner_code") {
      throw new Error("expected scanner_code event");
    }
    expect(parsed.maskedCode).toBe("6212****9012");
    expect((parsed as { maskedCode: string; authCode?: string }).authCode).toBe(
      undefined,
    );
  });
});
