import { describe, expect, it } from "vitest";

import { createMachineRuntimeTrace } from "./machine-runtime-trace";

describe("Machine Runtime Trace", () => {
  it("is bounded observability that preserves transition/request terminal correlation", () => {
    const trace = createMachineRuntimeTrace(2);
    trace.record({
      type: "journey_transition",
      transitionId: "transition-1",
      requestId: null,
      terminalOutcomeId: null,
      outcome: null,
      message: null,
      recordedAt: "2026-07-18T08:00:00.000Z",
    });
    trace.record({
      type: "audio_queued",
      transitionId: "transition-1",
      requestId: "request-1",
      terminalOutcomeId: null,
      outcome: null,
      message: null,
      recordedAt: "2026-07-18T08:00:01.000Z",
    });
    trace.record({
      type: "audio_terminal",
      transitionId: "transition-1",
      requestId: "request-1",
      terminalOutcomeId: "audio-terminal:request-1",
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
        terminalOutcomeId: "audio-terminal:request-1",
        outcome: "completed",
      }),
    ]);
  });

  it("orders navigation and correlated audio records in one runtime trace", () => {
    const trace = createMachineRuntimeTrace();
    trace.recordNavigation({
      intentType: "customer.touch",
      decision: "accepted",
      reasonCode: "touchscreen_session_renewed",
      fromRoute: "/catalog",
      requestedRoute: null,
      decidedRoute: null,
      finalRoute: null,
      targetRoute: null,
      sourceEventId: null,
      transactionOrderNo: null,
      transactionStage: "none",
      readinessRevision: "machine-test:1",
      touchscreenSessionActive: true,
    });
    trace.record({
      type: "journey_transition",
      transitionId: "touchscreen:session-1:awakened",
      requestId: null,
      terminalOutcomeId: null,
      outcome: null,
      message: null,
      recordedAt: "2026-07-18T08:30:00.000Z",
    });
    trace.record({
      type: "audio_terminal",
      transitionId: "touchscreen:session-1:awakened",
      requestId: "audio-request-1",
      terminalOutcomeId: "audio-terminal:audio-request-1",
      outcome: "completed",
      message: null,
      recordedAt: "2026-07-18T08:30:01.000Z",
    });

    expect(trace.entries()).toEqual([
      expect.objectContaining({ id: 1, type: "navigation" }),
      expect.objectContaining({
        id: 2,
        transitionId: "touchscreen:session-1:awakened",
      }),
      expect.objectContaining({
        id: 3,
        transitionId: "touchscreen:session-1:awakened",
        requestId: "audio-request-1",
        terminalOutcomeId: "audio-terminal:audio-request-1",
        outcome: "completed",
      }),
    ]);
  });

  it("publishes one atomic snapshot with a runtime-owned generation", () => {
    const trace = createMachineRuntimeTrace();
    trace.recordNavigation({
      intentType: "customer.touch",
      decision: "accepted",
      reasonCode: "touchscreen_session_renewed",
      fromRoute: "#/catalog",
      requestedRoute: null,
      decidedRoute: null,
      finalRoute: null,
      targetRoute: null,
      sourceEventId: null,
      transactionOrderNo: null,
      transactionStage: "none",
      readinessRevision: null,
      touchscreenSessionActive: true,
    });

    const snapshot = trace.snapshot();
    expect(snapshot.runtimeGenerationId).toMatch(/^runtime:/);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.id).toBe(1);
  });

  it("records correlated transaction result surfaces alongside navigation and audio entries", () => {
    const trace = createMachineRuntimeTrace();
    trace.record({
      type: "transaction_surface",
      route: "#/result/success",
      stage: "result",
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
      commandId: "command-1",
      resultKind: "success",
      resultDisplayIntent: "success",
      recordedAt: "2026-07-18T08:31:00.000Z",
    });

    expect(trace.entries()).toEqual([
      expect.objectContaining({
        id: 1,
        type: "transaction_surface",
        route: "#/result/success",
        stage: "result",
        orderId: "order-1",
        paymentId: "payment-1",
        orderNo: "ORD-1",
        commandId: "command-1",
        resultKind: "success",
        resultDisplayIntent: "success",
      }),
    ]);
  });
});
