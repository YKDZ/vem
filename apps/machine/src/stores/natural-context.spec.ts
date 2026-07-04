import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getNaturalContextMock } = vi.hoisted(() => ({
  getNaturalContextMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getNaturalContext: getNaturalContextMock,
  },
}));

import { useNaturalContextStore } from "./natural-context";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useNaturalContextStore", () => {
  it("loads daemon-owned Natural Context Projection", async () => {
    getNaturalContextMock.mockResolvedValue({
      status: "ready",
      machineCode: "MACHINE-NATURAL",
      checkedAt: "2026-06-30T14:00:00.000Z",
      degraded: true,
      customerFacingBlocked: false,
      externalEnvironment: {
        status: "ready",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "MACHINE-NATURAL",
        checkedAt: "2026-06-30T14:00:00.000Z",
        localTime: {
          status: "ready",
          timezone: "Asia/Shanghai",
          localDate: "2026-06-30",
          localClock: "22:00:00",
        },
        weather: {
          status: "ready",
          temperatureCelsius: 28,
          conditionText: "小雨",
          conditionCode: "305",
          observedAt: "2026-06-30T13:50:00.000Z",
          windScale: 8,
          windSpeedKph: 65,
          weatherConditionClasses: ["strong_wind", "light_rain"],
          primaryWeatherConditionClass: "strong_wind",
        },
        sun: {
          status: "ready",
          sunriseAt: "2026-06-29T21:53:00.000Z",
          sunsetAt: "2026-06-30T10:02:00.000Z",
        },
        calendar: {
          status: "ready",
          localDate: "2026-06-30",
          festivals: ["dragon_boat_festival"],
          primaryFestival: "dragon_boat_festival",
          solarTerm: null,
        },
      },
      localSiteSignals: {
        status: "unavailable",
      },
    });

    const store = useNaturalContextStore();
    await store.refresh();

    expect(store.snapshot?.status).toBe("ready");
    expect(store.degraded).toBe(true);
    expect(store.operatorMessage).toContain("Natural Context inputs");
    expect(store.weatherReady).toBe(true);
    expect(store.calendarReady).toBe(true);
    expect(store.weatherConditionClasses).toEqual([
      "strong_wind",
      "light_rain",
    ]);
    expect(store.primaryWeatherConditionClass).toBe("strong_wind");
    expect(store.festivals).toEqual(["dragon_boat_festival"]);
    expect(store.primaryFestival).toBe("dragon_boat_festival");
    expect(store.solarTerm).toBe(null);
  });
});
