// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";
import type { TransactionSnapshot } from "@/daemon/schemas";

import { useCheckoutStore } from "@/stores/checkout";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useVisionStore } from "@/stores/vision";

import {
  installCustomerAudioCueEventSource,
  recordCustomerAudioCueSourceFact,
  resetCustomerAudioCueEventSourceForTests,
} from "./useCustomerAudioCueEventSource";
import { onCustomerExperienceEvent } from "./useCustomerExperienceEvents";
import {
  resetCustomerPresenceSessionForTests,
  useCustomerPresenceSession,
} from "./usePresenceInteraction";

function applyNaturalContext(input: {
  checkedAt: string;
  sunriseAt: string;
  sunsetAt: string;
}): void {
  useNaturalContextStore().applySnapshot({
    status: "ready",
    machineCode: "MACHINE-PRESENCE",
    checkedAt: input.checkedAt,
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: {
      status: "ready",
      machineCode: "MACHINE-PRESENCE",
      checkedAt: input.checkedAt,
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: input.checkedAt.slice(0, 10),
        localClock: "12:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: 28,
        conditionText: "晴",
        conditionCode: "100",
        observedAt: input.checkedAt,
        weatherConditionClasses: ["other"],
        primaryWeatherConditionClass: "other",
      },
      sun: {
        status: "ready",
        sunriseAt: input.sunriseAt,
        sunsetAt: input.sunsetAt,
      },
      calendar: {
        status: "ready",
        localDate: input.checkedAt.slice(0, 10),
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
    },
    localSiteSignals: {
      status: "unknown",
    },
  });
}

function transactionSnapshot(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  const snapshot: TransactionSnapshot = {
    orderId: "order-197",
    orderNo: "VEM-ORDER-197",
    productSummary: null,
    paymentNo: "PAY-197",
    paymentMethod: "qr_code",
    paymentProvider: "mock",
    paymentUrl: "https://pay.example.test/197",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 1200,
    vending: null,
    nextAction: "wait_payment",
    paymentCodeAttempt: null,
    maskedAuthCode: null,
    operatorHint: null,
    errorCode: null,
    errorMessage: null,
    expiresAt: "2026-07-05T12:40:00.000Z",
    updatedAt: "2026-07-05T12:35:00.000Z",
  };
  return { ...snapshot, ...overrides } as TransactionSnapshot;
}

function emitPresence(personPresent: boolean, detectedAt: string): void {
  useVisionStore().applyPresenceStatus({
    eventId: `VISION-IDLE-${personPresent ? "PRESENT" : "EMPTY"}-${detectedAt}`,
    state: personPresent ? "approach" : "empty",
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    detectedAt,
    personPresent,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent },
    occupancy: {
      state: personPresent ? "single" : "none",
      confidence: 0.9,
    },
  });
}

describe("customer audio cue event source", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetCustomerPresenceSessionForTests();
  });

  afterEach(() => {
    resetCustomerPresenceSessionForTests();
    resetCustomerAudioCueEventSourceForTests();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("publishes source facts through the existing customer experience event bus", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      event: {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:45:00.000Z",
        nowMs: 1_788_522_300_000,
      },
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:45:00.000Z",
        nowMs: 1_788_522_300_000,
      },
    ]);
  });

  it("installs once and stops publishing after cleanup", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    const cleanup = installCustomerAudioCueEventSource();
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      event: {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:46:00.000Z",
      },
    });
    cleanup();
    recordCustomerAudioCueSourceFact({
      event: {
        type: "idle.sleep",
        requestedAt: "2026-07-05T12:46:30.000Z",
      },
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:46:00.000Z",
      },
    ]);
  });

  it("maps confirmed single-person presence facts to day welcome events", () => {
    applyNaturalContext({
      checkedAt: "2026-06-29T04:00:00.000Z",
      sunriseAt: "2026-06-28T21:53:00.000Z",
      sunsetAt: "2026-06-29T10:02:00.000Z",
    });
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T04:01:00.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.welcome.day",
        requestedAt: "2026-06-29T04:01:00.000Z",
      },
    ]);
  });

  it("does not treat restored or unknown occupancy facts as confirmed single-person presence", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:00:00.000Z",
      restored: true,
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: false,
      occupancyState: "none",
      observedAt: "2026-06-29T12:00:05.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "unknown",
      observedAt: "2026-06-29T12:01:00.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:01:03.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:01:03.000Z",
      },
    ]);
  });

  it("lets crowd presence outrank welcome and suppresses unchanged duplicate presence facts", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:10:00.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:10:01.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "multiple",
      observedAt: "2026-06-29T12:10:02.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "multiple",
      observedAt: "2026-06-29T12:10:03.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:10:00.000Z",
      },
      {
        type: "privacy.crowd_detected",
        requestedAt: "2026-06-29T12:10:02.000Z",
      },
    ]);
  });

  it("maps local awakened facts to interaction awakened events", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "local.awakened",
      requestedAt: "2026-06-29T12:12:00.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-06-29T12:12:00.000Z",
      },
    ]);
  });

  it("emits an assistance prompt when a browsing customer session becomes inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:38:00.000Z"));
    const routeName = ref("catalog");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const App = defineComponent({
      setup() {
        useCustomerPresenceSession({
          customerAssistancePromptMs: 1000,
          inactivityDepartureMs: 5000,
        });
        return () => null;
      },
    });
    const app = createApp(App);
    app.use(createPinia());
    app.mount(host);
    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    vi.advanceTimersByTime(1000);
    await nextTick();

    app.unmount();
    unsubscribe();
    expect(observed).toEqual([
      {
        type: "idle.assistance_prompt",
        requestedAt: "2026-07-05T12:38:01.000Z",
      },
    ]);
  });

  it("delays assistance prompt when an already-present customer keeps interacting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:38:00.000Z"));
    const routeName = ref("catalog");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const App = defineComponent({
      setup() {
        useCustomerPresenceSession({
          customerAssistancePromptMs: 1000,
          inactivityDepartureMs: 5000,
        });
        return () => null;
      },
    });
    const app = createApp(App);
    app.use(createPinia());
    app.mount(host);
    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    vi.advanceTimersByTime(800);
    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(observed).toEqual([]);

    vi.advanceTimersByTime(800);
    await nextTick();

    app.unmount();
    unsubscribe();
    expect(observed).toEqual([
      {
        type: "idle.assistance_prompt",
        requestedAt: "2026-07-05T12:38:01.800Z",
      },
    ]);
  });

  it("emits sleep once when a browsing customer session returns to rest after long idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:39:00.000Z"));
    const routeName = ref("product-detail");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const App = defineComponent({
      setup() {
        useCustomerPresenceSession({
          customerAssistancePromptMs: 1000,
          inactivityDepartureMs: 3000,
        });
        return () => null;
      },
    });
    const app = createApp(App);
    app.use(createPinia());
    app.mount(host);
    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    vi.advanceTimersByTime(3000);
    await nextTick();
    vi.advanceTimersByTime(10_000);
    await nextTick();

    app.unmount();
    unsubscribe();
    expect(observed).toEqual([
      {
        type: "idle.assistance_prompt",
        requestedAt: "2026-07-05T12:39:01.000Z",
      },
      {
        type: "idle.sleep",
        requestedAt: "2026-07-05T12:39:03.000Z",
      },
    ]);
  });

  it("emits sleep once when a present customer departs", async () => {
    const routeName = ref("catalog");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const App = defineComponent({
      setup() {
        useCustomerPresenceSession();
        return () => null;
      },
    });
    const app = createApp(App);
    app.use(createPinia());
    app.mount(host);
    emitPresence(true, "2026-07-05T12:40:00.000Z");
    await nextTick();
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    useVisionStore().applyPersonDeparted({
      eventId: "VISION-IDLE-DEPARTURE-001",
      detectedAt: "2026-07-05T12:40:05.000Z",
      lastSeenAt: "2026-07-05T12:40:04.000Z",
      reason: "left_frame",
    });
    await nextTick();
    useVisionStore().applyPersonDeparted({
      eventId: "VISION-IDLE-DEPARTURE-002",
      detectedAt: "2026-07-05T12:40:06.000Z",
      lastSeenAt: "2026-07-05T12:40:04.000Z",
      reason: "left_frame",
    });
    await nextTick();

    app.unmount();
    unsubscribe();
    expect(observed).toEqual([
      {
        type: "idle.sleep",
        requestedAt: "2026-07-05T12:40:05.000Z",
      },
    ]);
  });

  it("does not emit assistance prompts on transaction waiting and terminal routes", () => {
    const routeName = ref("payment");
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    for (const [route, occurredAt] of [
      ["payment", "2026-07-05T12:41:00.000Z"],
      ["dispensing", "2026-07-05T12:41:01.000Z"],
      ["result", "2026-07-05T12:41:02.000Z"],
    ] as const) {
      routeName.value = route;
      recordCustomerAudioCueSourceFact({
        type: "customer_session.idle",
        idleEvent: "assistance_prompt",
        occurredAt,
      });
    }

    unsubscribe();
    expect(observed).toEqual([]);
  });

  it("does not duplicate repeated idle source facts", () => {
    const routeName = ref("catalog");
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource({ routeName });

    for (const idleEvent of ["assistance_prompt", "sleep"] as const) {
      recordCustomerAudioCueSourceFact({
        type: "customer_session.idle",
        idleEvent,
        occurredAt: `2026-07-05T12:42:0${idleEvent === "sleep" ? "1" : "0"}.000Z`,
      });
      recordCustomerAudioCueSourceFact({
        type: "customer_session.idle",
        idleEvent,
        occurredAt: `2026-07-05T12:42:0${idleEvent === "sleep" ? "1" : "0"}.000Z`,
      });
    }

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "idle.assistance_prompt",
        requestedAt: "2026-07-05T12:42:00.000Z",
      },
      {
        type: "idle.sleep",
        requestedAt: "2026-07-05T12:42:01.000Z",
      },
    ]);
  });

  it("emits one payment prompt for repeated payment-waiting observations of the same current order", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transactionSnapshot());
    checkoutStore.applyTransaction({
      ...checkoutStore.transaction!,
      updatedAt: "2026-07-05T12:35:02.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "payment.prompt",
        orderKey: "VEM-ORDER-197",
      },
    ]);
  });

  it("does not emit a payment prompt from a restored payment-waiting current transaction", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    useCheckoutStore().applyTransaction(transactionSnapshot(), {
      restored: true,
    });

    unsubscribe();
    expect(observed).toEqual([]);
  });

  it("does not emit dispensing cues from a restored dispensing current transaction", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    useCheckoutStore().applyTransaction(
      transactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "dispensing",
        nextAction: "dispensing",
        vending: {
          commandNo: "VEND-197",
          status: "sent",
          lastError: null,
          pickupReminder: null,
        },
      }),
      { restored: true },
    );

    unsubscribe();
    expect(observed).toEqual([]);
  });

  it("does not emit result cues from restored terminal current transactions", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    const restoredTerminalResults = [
      ["success", "fulfilled", "succeeded"],
      ["dispense_failed", "dispense_failed", "failed"],
      ["refund_pending", "refund_pending", "failed"],
      ["refunded", "refunded", "failed"],
      ["manual_handling", "manual_handling", "result_unknown"],
    ] as const;

    for (const [
      nextAction,
      orderStatus,
      vendingStatus,
    ] of restoredTerminalResults) {
      checkoutStore.applyTransaction(
        transactionSnapshot({
          orderId: `order-197-restored-${nextAction}`,
          orderNo: `VEM-ORDER-197-RESTORED-${nextAction}`,
          paymentStatus:
            nextAction === "refund_pending"
              ? "refund_pending"
              : nextAction === "refunded"
                ? "refunded"
                : "succeeded",
          orderStatus,
          nextAction,
          vending: {
            commandNo: `VEND-197-RESTORED-${nextAction}`,
            status: vendingStatus,
            lastError: vendingStatus === "failed" ? "slot jammed" : null,
            pickupReminder: null,
          },
          updatedAt: "2026-07-05T12:36:30.000Z",
        }),
        { restored: true },
      );
    }

    unsubscribe();
    expect(observed).toEqual([]);
  });

  it("emits payment succeeded and dispensing started when a paid order enters dispensing", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transactionSnapshot());
    checkoutStore.applyTransaction(
      transactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "dispensing",
        nextAction: "dispensing",
        vending: {
          commandNo: "VEND-197",
          status: "sent",
          lastError: null,
          pickupReminder: null,
        },
        updatedAt: "2026-07-05T12:35:05.000Z",
      }),
    );
    checkoutStore.applyTransaction(
      transactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "dispensing",
        nextAction: "dispensing",
        vending: {
          commandNo: "VEND-197",
          status: "acknowledged",
          lastError: null,
          pickupReminder: null,
        },
        updatedAt: "2026-07-05T12:35:07.000Z",
      }),
    );

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "payment.prompt",
        orderKey: "VEM-ORDER-197",
      },
      {
        type: "payment.succeeded",
        orderKey: "VEM-ORDER-197",
      },
      {
        type: "dispensing.started",
        orderKey: "VEM-ORDER-197",
      },
    ]);
  });

  it("emits payment and dispensing cues when a restored payment-waiting order later enters dispensing", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    checkoutStore.applyTransaction(transactionSnapshot(), {
      restored: true,
    });
    checkoutStore.applyTransaction(
      transactionSnapshot({
        paymentStatus: "succeeded",
        orderStatus: "dispensing",
        nextAction: "dispensing",
        vending: {
          commandNo: "VEND-197",
          status: "sent",
          lastError: null,
          pickupReminder: null,
        },
        updatedAt: "2026-07-05T12:35:05.000Z",
      }),
    );

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "payment.succeeded",
        orderKey: "VEM-ORDER-197",
      },
      {
        type: "dispensing.started",
        orderKey: "VEM-ORDER-197",
      },
    ]);
  });

  it("maps terminal transaction results to order-scoped customer audio cue events without pickup completion", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    const terminalResults = [
      ["success", "fulfilled", "succeeded", "dispense.succeeded"],
      ["dispense_failed", "dispense_failed", "failed", "dispense.failed"],
      ["refund_pending", "refund_pending", "failed", "refund.pending"],
      ["refunded", "refunded", "failed", "refund.completed"],
      [
        "manual_handling",
        "manual_handling",
        "result_unknown",
        "manual_handling.required",
      ],
    ] as const;
    const expectedEvents: CustomerExperienceEvent[] = [];

    for (const [
      nextAction,
      orderStatus,
      vendingStatus,
      eventType,
    ] of terminalResults) {
      const orderNo = `VEM-ORDER-197-${nextAction}`;
      checkoutStore.applyTransaction(
        transactionSnapshot({
          orderId: `order-197-${nextAction}`,
          orderNo,
          paymentStatus:
            nextAction === "refund_pending"
              ? "refund_pending"
              : nextAction === "refunded"
                ? "refunded"
                : "succeeded",
          orderStatus,
          nextAction,
          vending: {
            commandNo: `VEND-197-${nextAction}`,
            status: vendingStatus,
            lastError: vendingStatus === "failed" ? "slot jammed" : null,
            pickupReminder:
              nextAction === "success"
                ? {
                    level: "warning",
                    message: "请及时取走商品",
                    warningNo: 1,
                    reportedAt: "2026-07-05T12:36:00.000Z",
                  }
                : null,
          },
          updatedAt: "2026-07-05T12:36:00.000Z",
        }),
      );
      checkoutStore.applyTransaction({
        ...checkoutStore.transaction!,
        updatedAt: "2026-07-05T12:36:02.000Z",
      });
      expectedEvents.push({
        type: eventType,
        orderKey: orderNo,
      });
    }

    unsubscribe();
    expect(observed).toEqual(expectedEvents);
    expect(observed).not.toContainEqual(
      expect.objectContaining({ type: "pickup.completed" }),
    );
  });

  it("emits the same terminal result cue independently for a different order number", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    for (const orderNo of ["VEM-ORDER-197-A", "VEM-ORDER-197-B"]) {
      checkoutStore.applyTransaction(
        transactionSnapshot({
          orderId: `order-${orderNo}`,
          orderNo,
          paymentStatus: "succeeded",
          orderStatus: "fulfilled",
          nextAction: "success",
          vending: {
            commandNo: `VEND-${orderNo}`,
            status: "succeeded",
            lastError: null,
            pickupReminder: null,
          },
          updatedAt: "2026-07-05T12:36:10.000Z",
        }),
      );
    }

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "dispense.succeeded",
        orderKey: "VEM-ORDER-197-A",
      },
      {
        type: "dispense.succeeded",
        orderKey: "VEM-ORDER-197-B",
      },
    ]);
  });

  it("does not emit transaction audio cue events for payment failed, payment expired, or closed results", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    const checkoutStore = useCheckoutStore();
    const reservedResults = [
      ["payment_failed", "pending_payment", "failed"],
      ["payment_expired", "payment_expired", "expired"],
      ["closed", "closed", "canceled"],
    ] as const;

    for (const [nextAction, orderStatus, paymentStatus] of reservedResults) {
      checkoutStore.applyTransaction(
        transactionSnapshot({
          orderId: `order-197-${nextAction}`,
          orderNo: `VEM-ORDER-197-${nextAction}`,
          paymentStatus,
          orderStatus,
          nextAction,
          vending: null,
          updatedAt: "2026-07-05T12:37:00.000Z",
        }),
      );
    }

    unsubscribe();
    expect(observed).toEqual([]);
  });
});
