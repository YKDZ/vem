import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startEnvironmentCommandPoller,
  type EnvironmentCommandSnapshot,
} from "./environment-command-poller";

describe("environment command poller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues polling a matched command until a terminal status", async () => {
    vi.useFakeTimers();
    const acknowledged: EnvironmentCommandSnapshot = {
      commandNo: "MCMD-POLL",
      status: "acknowledged",
    };
    const succeeded: EnvironmentCommandSnapshot = {
      commandNo: "MCMD-POLL",
      status: "succeeded",
    };
    const snapshots = [acknowledged, succeeded];
    const fetchMachine = vi.fn(async () => ({
      latestEnvironmentCommand: snapshots.shift() ?? succeeded,
    }));
    const observed: EnvironmentCommandSnapshot[] = [];

    const poller = startEnvironmentCommandPoller({
      commandNo: "MCMD-POLL",
      fetchMachine,
      isActive: () => true,
      onCommand: (command) => observed.push(command),
      intervalMs: 50,
      maxAttempts: 4,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMachine).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);

    await expect(poller.promise).resolves.toEqual(succeeded);
    expect(observed.map((command) => command.status)).toEqual([
      "acknowledged",
      "succeeded",
    ]);
  });
});
