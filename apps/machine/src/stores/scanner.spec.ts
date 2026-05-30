import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useScannerStore } from "./scanner";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("scanner store", () => {
  it("applies scanner health status", () => {
    const store = useScannerStore();
    store.applyStatus({
      online: false,
      adapter: "serial_text",
      port: "COM4",
      level: "offline",
      code: "SCANNER_OPEN_FAILED",
      message: "open scanner serial failed",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(store.code).toBe("SCANNER_OPEN_FAILED");
    expect(store.port).toBe("COM4");
    expect(store.level).toBe("offline");
  });

  it("stores masked scan only", () => {
    const store = useScannerStore();
    store.applyScan("6212****3456", 1700000000000);

    expect(store.lastMaskedCode).toBe("6212****3456");
    expect(store.lastScannedAtMs).toBe(1700000000000);
    expect(store.message).toBe("已接收到付款码");
  });
});
