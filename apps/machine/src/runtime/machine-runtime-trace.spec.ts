import { describe, expect, it } from "vitest";

import { createMachineRuntimeTrace } from "./machine-runtime-trace";

describe("Machine Runtime Trace", () => {
  it("is bounded observability that preserves transition/request terminal correlation", () => {
    const trace = createMachineRuntimeTrace(2);
    trace.record({
      type: "journey_transition",
      transitionId: "transition-1",
      requestId: null,
      outcome: null,
      message: null,
      recordedAt: "2026-07-18T08:00:00.000Z",
    });
    trace.record({
      type: "audio_queued",
      transitionId: "transition-1",
      requestId: "request-1",
      outcome: null,
      message: null,
      recordedAt: "2026-07-18T08:00:01.000Z",
    });
    trace.record({
      type: "audio_terminal",
      transitionId: "transition-1",
      requestId: "request-1",
      outcome: "completed",
      message: null,
      recordedAt: "2026-07-18T08:00:02.000Z",
    });

    expect(trace.entries()).toEqual([
      expect.objectContaining({ type: "audio_queued", requestId: "request-1" }),
      expect.objectContaining({
        type: "audio_terminal",
        transitionId: "transition-1",
        requestId: "request-1",
        outcome: "completed",
      }),
    ]);
  });
});
