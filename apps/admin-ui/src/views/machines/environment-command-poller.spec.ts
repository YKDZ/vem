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

  it("ignores an in-flight terminal result after it is stopped", async () => {
    vi.useFakeTimers();
    let resolveMachine:
      | ((machine: {
          latestEnvironmentCommand: EnvironmentCommandSnapshot;
        }) => void)
      | undefined;
    const fetchMachine = vi.fn(
      () =>
        new Promise<{ latestEnvironmentCommand: EnvironmentCommandSnapshot }>(
          (resolve) => {
            resolveMachine = resolve;
          },
        ),
    );
    const onCommand = vi.fn();
    const poller = startEnvironmentCommandPoller({
      commandNo: "MCMD-POLL",
      fetchMachine,
      isActive: () => true,
      onCommand,
      intervalMs: 50,
      maxAttempts: 4,
    });

    expect(fetchMachine).toHaveBeenCalledTimes(1);
    poller.stop();
    if (!resolveMachine) throw new Error("Expected in-flight fetch resolver");
    resolveMachine({
      latestEnvironmentCommand: {
        commandNo: "MCMD-POLL",
        status: "succeeded",
      },
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(poller.promise).resolves.toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
    expect(fetchMachine).toHaveBeenCalledTimes(1);
  });
});
