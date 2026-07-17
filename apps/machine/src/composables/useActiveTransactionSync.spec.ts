// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installActiveTransactionSync } from "./useActiveTransactionSync";

describe("active transaction sync", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes globally while payment or dispensing is active", async () => {
    const stage = ref<"none" | "payment" | "dispensing" | "result">("none");
    const refresh = vi.fn().mockResolvedValue(null);
    const cleanup = installActiveTransactionSync({
      stage: () => stage.value,
      refresh,
      intervalMs: 2_000,
    });

    stage.value = "payment";
    await nextTick();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    stage.value = "dispensing";
    await nextTick();
    expect(refresh).toHaveBeenCalledTimes(4);

    stage.value = "result";
    await nextTick();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refresh).toHaveBeenCalledTimes(4);

    cleanup();
  });

  it("stops refreshing after cleanup", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const cleanup = installActiveTransactionSync({
      stage: () => "payment",
      refresh,
      intervalMs: 2_000,
    });
    cleanup();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
