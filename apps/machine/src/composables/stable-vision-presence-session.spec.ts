// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { useVisionStore } from "@/stores/vision";

import {
  getStableVisionPresenceSession,
  resetStableVisionPresenceSessionForTests,
} from "./stable-vision-presence-session";

function present(eventId: string): void {
  useVisionStore().applyPresenceStatus({
    source: "top",
    eventId,
    state: "approach",
    reason: "person_present_but_not_close",
    detectedAt: "2026-07-22T10:00:00.000Z",
    personPresent: true,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: true, closeNow: false, close: false },
    occupancy: { state: "single", confidence: 0.91 },
  });
}

function absent(eventId: string): void {
  useVisionStore().applyPersonDeparted({
    source: "top",
    eventId,
    detectedAt: "2026-07-22T10:00:01.000Z",
    lastSeenAt: "2026-07-22T10:00:00.000Z",
    reason: "left_frame",
  });
}

describe("stable Vision presence session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetStableVisionPresenceSessionForTests();
  });

  afterEach(() => {
    resetStableVisionPresenceSessionForTests();
    vi.useRealTimers();
  });

  it("emits one arrival and one departure after ten continuous seconds of absence", async () => {
    const session = getStableVisionPresenceSession();

    present("PRESENT-1");
    await nextTick();
    expect(session.state.value).toMatchObject({
      present: true,
      edge: "arrival",
      edgeId: "vision-presence-1:arrival",
    });

    present("PRESENT-2");
    absent("ABSENT-1");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(session.state.value.present).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(session.state.value).toMatchObject({
      present: false,
      edge: "departure",
      edgeId: "vision-presence-2:departure",
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state.value.edgeId).toBe("vision-presence-2:departure");
  });

  it("cancels short absence and freezes an established session while Vision is unavailable", async () => {
    const session = getStableVisionPresenceSession();
    present("PRESENT-1");
    absent("ABSENT-1");
    await vi.advanceTimersByTimeAsync(9_000);
    present("PRESENT-2");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.state.value).toMatchObject({
      present: true,
      edgeId: "vision-presence-1:arrival",
    });

    useVisionStore().applyStatus({
      enabled: true,
      online: false,
      message: "Vision unavailable",
      latestDiagnosticPayload: null,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state.value).toMatchObject({
      present: true,
      edgeId: "vision-presence-1:arrival",
    });
  });
});
