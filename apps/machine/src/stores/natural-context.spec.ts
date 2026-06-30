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
      status: "unconfigured",
      machineCode: "MACHINE-NATURAL",
      checkedAt: "2026-06-30T14:00:00.000Z",
      degraded: true,
      customerFacingBlocked: false,
      externalEnvironment: {
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "MACHINE-NATURAL",
        checkedAt: "2026-06-30T14:00:00.000Z",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      },
      localSiteSignals: {
        status: "unavailable",
      },
    });

    const store = useNaturalContextStore();
    await store.refresh();

    expect(store.snapshot?.status).toBe("unconfigured");
    expect(store.degraded).toBe(true);
    expect(store.operatorMessage).toContain(
      "Machine Geo Location is not configured",
    );
  });
});
