import { describe, expect, it, vi } from "vitest";

import { BootCheckTimeoutError, runBoundedBootCheck } from "./boot-check";

describe("runBoundedBootCheck", () => {
  it("fails a stalled boot check within its configured bound", async () => {
    vi.useFakeTimers();
    const stalled = new Promise<void>(() => undefined);
    const result = runBoundedBootCheck(() => stalled, 1_000);
    void result.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).rejects.toBeInstanceOf(BootCheckTimeoutError);
    vi.useRealTimers();
  });

  it("aborts the boot work when its bound expires so late work cannot own startup", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const stalled = new Promise<void>(() => undefined);
    const result = runBoundedBootCheck((signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return stalled;
    }, 1_000);
    void result.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).rejects.toBeInstanceOf(BootCheckTimeoutError);
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });
});
