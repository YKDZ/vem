import { describe, expect, it } from "vitest";

import {
  createMockHardwareAdapter,
  getMockDispenseMode,
  setMockDispenseMode,
} from "./mock-adapter";

const command = {
  commandNo: "CMD1",
  orderNo: "ORD1",
  slot: { layerNo: 1, cellNo: 1, slotCode: "A1" },
  quantity: 1,
  timeoutSeconds: 120,
};

describe("mock hardware adapter", () => {
  it("defaults to success", async () => {
    const storage = new Map<string, string>();
    const adapter = createMockHardwareAdapter({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as unknown as Storage);

    const result = await adapter.dispense(command);
    expect(result.success).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("supports jammed failure mode", async () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as unknown as Storage;
    setMockDispenseMode("jammed", fakeStorage);
    expect(getMockDispenseMode(fakeStorage)).toBe("jammed");

    const result =
      await createMockHardwareAdapter(fakeStorage).dispense(command);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("JAMMED");
  });
});
