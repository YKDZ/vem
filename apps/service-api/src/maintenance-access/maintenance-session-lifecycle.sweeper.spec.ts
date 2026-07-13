import { describe, expect, it, vi } from "vitest";

import { MaintenanceSessionLifecycleSweeper } from "./maintenance-session-lifecycle.sweeper";

describe("MaintenanceSessionLifecycleSweeper", () => {
  it("sweeps on startup and every interval using the injected clock, then stops on shutdown", async () => {
    const firstNow = new Date("2026-07-10T12:00:00.000Z");
    const secondNow = new Date("2026-07-10T12:00:05.000Z");
    const now = vi
      .fn()
      .mockReturnValueOnce(firstNow)
      .mockReturnValue(secondNow);
    const sweepExpiredSessions = vi.fn().mockResolvedValue(undefined);
    let tick: (() => void) | undefined;
    const handle = { lifecycle: true };
    const set = vi.fn((callback: () => void) => {
      tick = callback;
      return handle;
    });
    const clear = vi.fn();
    const sweeper = new MaintenanceSessionLifecycleSweeper(
      { sweepExpiredSessions } as never,
      { now },
      { set, clear },
    );

    await sweeper.onModuleInit();
    expect(sweepExpiredSessions).toHaveBeenCalledWith(firstNow);
    expect(set).toHaveBeenCalledWith(expect.any(Function), 5_000);

    tick?.();
    await vi.waitFor(() => {
      expect(sweepExpiredSessions).toHaveBeenCalledWith(secondNow);
    });

    sweeper.onApplicationShutdown();
    expect(clear).toHaveBeenCalledWith(handle);
  });

  it("coalesces concurrent interval ticks into one database sweep", async () => {
    let finishSweep: (() => void) | undefined;
    const sweepExpiredSessions = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishSweep = resolve;
        });
      });
    let tick: (() => void) | undefined;
    const sweeper = new MaintenanceSessionLifecycleSweeper(
      { sweepExpiredSessions } as never,
      { now: () => new Date("2026-07-10T12:00:05.000Z") },
      {
        set: (callback) => {
          tick = callback;
          return 1;
        },
        clear: () => undefined,
      },
    );
    await sweeper.onModuleInit();

    tick?.();
    tick?.();
    await vi.waitFor(() => {
      expect(sweepExpiredSessions).toHaveBeenCalledTimes(2);
    });

    finishSweep?.();
    await vi.waitFor(() => {
      expect(sweepExpiredSessions).toHaveBeenCalledTimes(2);
    });
  });
});
