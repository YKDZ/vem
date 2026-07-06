import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { controlEnvironmentMock } = vi.hoisted(() => ({
  controlEnvironmentMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    controlEnvironment: controlEnvironmentMock,
  },
}));

import { useEnvironmentControlStore } from "./environment-control";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useEnvironmentControlStore", () => {
  it("wraps air conditioner control as a store action", async () => {
    controlEnvironmentMock.mockResolvedValue({
      commandNo: "local-env-1",
      success: true,
      errorCode: null,
      message: "environment control completed",
      airConditionerOn: true,
      targetTemperatureCelsius: 24,
      ventSpeed: 2,
      reportedAt: "2026-07-01T07:00:00.000Z",
    });

    const store = useEnvironmentControlStore();
    const result = await store.controlAirConditioner({
      airConditionerOn: true,
      targetTemperatureCelsius: 24,
      ventSpeed: 2,
    });

    expect(controlEnvironmentMock).toHaveBeenCalledWith({
      airConditionerOn: true,
      targetTemperatureCelsius: 24,
      ventSpeed: 2,
      timeoutSeconds: 5,
    });
    expect(result.success).toBe(true);
    expect(store.latestControlSucceeded).toBe(true);
    expect(store.airConditionerOn).toBe(true);
    expect(store.targetTemperatureCelsius).toBe(24);
    expect(store.ventSpeed).toBe(2);
    expect(store.error).toBeNull();
  });

  it("validates control requests before calling daemon", async () => {
    const store = useEnvironmentControlStore();

    await expect(
      store.controlAirConditioner({ targetTemperatureCelsius: 31 }),
    ).rejects.toThrow();

    expect(controlEnvironmentMock).not.toHaveBeenCalled();
  });

  it("records failed control results without throwing", async () => {
    controlEnvironmentMock.mockResolvedValue({
      commandNo: "local-env-2",
      success: false,
      errorCode: "air_conditioner_switch_failed",
      message: "lower controller rejected air conditioner switch",
      airConditionerOn: null,
      targetTemperatureCelsius: null,
      reportedAt: "2026-07-01T07:01:00.000Z",
    });

    const store = useEnvironmentControlStore();
    const result = await store.controlAirConditioner({
      airConditionerOn: false,
    });

    expect(result.success).toBe(false);
    expect(store.latestControlSucceeded).toBe(false);
    expect(store.error).toBe(
      "lower controller rejected air conditioner switch",
    );
  });
});
