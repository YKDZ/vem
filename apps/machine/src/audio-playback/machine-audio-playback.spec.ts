import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HealthSnapshot, TransactionSnapshot } from "@/daemon/schemas";

import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";

import {
  createBrowserMachineAudioPlaybackDriver,
  createMachineAudioPlayback,
  createMockMachineAudioPlaybackDriver,
  type BrowserMachineAudioElement,
} from "./machine-audio-playback";

class MockBrowserAudio implements BrowserMachineAudioElement {
  readonly src: string;
  currentTime = 0;
  volume = 1;
  readonly play = vi.fn<() => Promise<void>>();
  readonly pause = vi.fn<() => void>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(src: string, playResult: Promise<void> = Promise.resolve()) {
    this.src = src;
    this.play.mockReturnValue(playResult);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function transaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440150",
    orderNo: "ORD-MACHINE-AUDIO-001",
    productSummary: null,
    paymentNo: "PAY-MACHINE-AUDIO-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "manual_handling",
    totalAmountCents: 4900,
    vending: {
      commandNo: "CMD-MACHINE-AUDIO-001",
      status: "result_unknown",
      lastError: "dispense result unknown",
    },
    nextAction: "manual_handling",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-07-03T08:02:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-07-03T08:02:01.000Z",
    ...overrides,
  } as TransactionSnapshot;
}

function healthyRuntimeSnapshot(): HealthSnapshot {
  return {
    status: "healthy",
    process: {
      component: "process",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-07-03T08:02:00.000Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: false,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 1000,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-07-03T08:02:00.000Z",
  };
}

function applyReadyRuntime(): void {
  const connectivityStore = useConnectivityStore();
  connectivityStore.applyHealth(healthyRuntimeSnapshot());
  connectivityStore.applyReady({
    ready: true,
    canSell: true,
    mode: "catalog",
    blockingCodes: [],
    blockingReasons: [],
    degradedReasons: [],
    suggestedRoute: "catalog",
    updatedAt: "2026-07-03T08:02:00.000Z",
  });
  connectivityStore.applySaleReadiness({
    canStartNetworkAuthorizedSale: true,
    blockingCodes: [],
    components: {
      platformReachability: {
        ready: true,
        code: "PLATFORM_REACHABLE",
        message: "platform reachable",
      },
      machineAuthentication: {
        ready: true,
        code: "MACHINE_AUTH_READY",
        message: "machine authenticated",
      },
      activePlanogram: {
        ready: true,
        code: "ACTIVE_PLANOGRAM_READY",
        message: "PLAN-1",
      },
      paymentOptions: {
        ready: true,
        code: "PAYMENT_OPTIONS_READY",
        message: "payment ready",
        methods: [],
      },
      scannerCapability: {
        ready: true,
        code: "SCANNER_READY",
        message: "scanner ready",
      },
      syncHealth: {
        ready: true,
        code: "SYNC_READY",
        message: "sync ready",
      },
      wholeMachineBlockers: {
        ready: true,
        code: "WHOLE_MACHINE_READY",
        message: "machine ready",
      },
      slotSaleSafety: {
        ready: true,
        code: "SLOT_SALE_SAFETY_READY",
        message: "slot ready",
        blockedSlots: [],
      },
    },
  });
}

function checkoutObservation() {
  const checkoutStore = useCheckoutStore();
  const checkoutView = checkoutStore.customerCheckoutView;
  const transaction = checkoutStore.transaction;
  return {
    stage: checkoutView.stage,
    resultKind: checkoutView.result?.kind ?? null,
    nextAction: transaction?.nextAction ?? null,
    paymentStatus: transaction?.paymentStatus ?? null,
    orderStatus: transaction?.orderStatus ?? null,
    vendingStatus: transaction?.vending?.status ?? null,
    orderNo: checkoutView.orderCredential,
  };
}

function readinessObservation() {
  const machineStore = useMachineStore();
  const connectivityStore = useConnectivityStore();
  return {
    machineCanSell: machineStore.canSell,
    machineHealth: machineStore.health,
    saleNetworkReady: connectivityStore.isSaleNetworkReady,
    ready: connectivityStore.ready,
    saleReadiness: connectivityStore.saleReadiness,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("createMachineAudioPlayback", () => {
  it("plays a local packaged audio URL through the mock driver and records request diagnostics", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/customer-greeting.wav");

    expect(playback.currentDriver()).toBe("mock");
    expect(driver.requests).toEqual([
      {
        sourceUrl: "/assets/customer-greeting.wav",
        volume: 1,
      },
    ]);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "mock",
      sourceUrl: "/assets/customer-greeting.wav",
    });
  });

  it("passes normalized global Machine Audio volume to the mock driver", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({
      driver,
      volume: 0.35,
    });

    await playback.playLocal("/assets/customer-greeting.wav");

    expect(driver.requests).toEqual([
      {
        sourceUrl: "/assets/customer-greeting.wav",
        volume: 0.35,
      },
    ]);
  });

  it("passes the requested bound output device id to the active driver", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({
      driver,
      outputDeviceId: "{0.0.0.00000000}.bound-speaker",
    });

    await playback.playLocal("/assets/customer-greeting.wav");

    expect(driver.requests).toEqual([
      {
        sourceUrl: "/assets/customer-greeting.wav",
        volume: 1,
        outputDeviceId: "{0.0.0.00000000}.bound-speaker",
      },
    ]);
  });

  it("plays a local packaged audio URL through the browser driver", async () => {
    const created: MockBrowserAudio[] = [];
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({ driver });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(true);
    expect(playback.currentDriver()).toBe("browser");
    expect(created).toHaveLength(1);
    expect(created[0].src).toBe("/assets/payment-succeeded.wav");
    expect(created[0].play).toHaveBeenCalledTimes(1);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      sourceUrl: "/assets/payment-succeeded.wav",
    });
  });

  it("plays a local packaged audio URL through the native driver when it is preferred", async () => {
    const nativeDriver = createMockMachineAudioPlaybackDriver("native");
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: () => new MockBrowserAudio("/unused.wav"),
    });
    const playback = createMachineAudioPlayback({
      nativeDriver,
      browserDriver,
    });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(true);
    expect(playback.currentDriver()).toBe("native");
    expect(nativeDriver.requests).toEqual([
      {
        sourceUrl: "/assets/payment-succeeded.wav",
        volume: 1,
      },
    ]);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "native",
      sourceUrl: "/assets/payment-succeeded.wav",
    });
  });

  it("falls back to browser playback once when native playback fails to start", async () => {
    const nativeStops: string[] = [];
    const nativeDriver = {
      name: "native" as const,
      playLocal: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("native output unavailable")),
      stop: vi.fn(() => {
        nativeStops.push(new Date().toISOString());
      }),
    };
    const created: MockBrowserAudio[] = [];
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({
      nativeDriver,
      browserDriver,
    });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(true);
    expect(nativeDriver.playLocal).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].play).toHaveBeenCalledTimes(1);
    expect(playback.currentDriver()).toBe("browser");
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      sourceUrl: "/assets/payment-succeeded.wav",
      message: "native playback degraded: native output unavailable",
    });
    expect(nativeStops).toEqual([]);
  });

  it("does not fall back to browser playback when strict native output binding is required", async () => {
    const nativeDriver = {
      name: "native" as const,
      playLocal: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("configured audio output binding not found")),
      stop: vi.fn(),
    };
    const created: MockBrowserAudio[] = [];
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({
      nativeDriver,
      browserDriver,
      outputDeviceId: "{0.0.0.00000000}.missing-speaker",
      requireNativeOutputBinding: true,
    });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(false);
    expect(nativeDriver.playLocal).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
    expect(playback.currentDriver()).toBe("native");
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "failed",
      driver: "native",
      sourceUrl: "/assets/payment-succeeded.wav",
      message: "configured audio output binding not found",
    });
  });

  it("fails before playback when strict native output binding is required but no output device is confirmed", async () => {
    const nativeDriver = createMockMachineAudioPlaybackDriver("native");
    const created: MockBrowserAudio[] = [];
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({
      nativeDriver,
      browserDriver,
      requireNativeOutputBinding: true,
    });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(false);
    expect(nativeDriver.requests).toEqual([]);
    expect(created).toHaveLength(0);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "failed",
      driver: "native",
      sourceUrl: "/assets/payment-succeeded.wav",
      message: "confirmed audio output binding is required",
    });
  });

  it("falls back to browser playback when native playback is unavailable", async () => {
    const created: MockBrowserAudio[] = [];
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({
      nativeDriver: null,
      browserDriver,
    });

    const played = await playback.playLocal("/assets/presence-greeting.wav");

    expect(played).toBe(true);
    expect(created).toHaveLength(1);
    expect(playback.currentDriver()).toBe("browser");
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      sourceUrl: "/assets/presence-greeting.wav",
      message: "native playback degraded: native playback unavailable",
    });
  });

  it("records browser fallback failure without automatically retrying", async () => {
    const nativeDriver = {
      name: "native" as const,
      playLocal: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("native output unavailable")),
      stop: vi.fn(),
    };
    const created: MockBrowserAudio[] = [];
    const browserDriver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(
          sourceUrl,
          Promise.reject(new Error("NotAllowedError")),
        );
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({
      nativeDriver,
      browserDriver,
    });

    const played = await playback.playLocal("/assets/refund-pending.wav");

    expect(played).toBe(false);
    expect(nativeDriver.playLocal).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].play).toHaveBeenCalledTimes(1);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "failed",
      driver: "browser",
      sourceUrl: "/assets/refund-pending.wav",
      message:
        "native playback degraded: native output unavailable; NotAllowedError",
    });
  });

  it("sets normalized global Machine Audio volume on browser playback", async () => {
    const created: MockBrowserAudio[] = [];
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(sourceUrl);
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({ driver, volume: 0.35 });

    await playback.playLocal("/assets/payment-succeeded.wav");

    expect(created).toHaveLength(1);
    expect(created[0].volume).toBe(0.35);
    expect(created[0].play).toHaveBeenCalledTimes(1);
  });

  it("exposes the requested diagnostic while driver playback is starting", async () => {
    let resolvePlay!: () => void;
    const playStarted = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => new MockBrowserAudio(sourceUrl, playStarted),
    });
    const playback = createMachineAudioPlayback({ driver });

    const request = playback.playLocal("/assets/payment-prompt.wav");

    expect(playback.latestDiagnostic()).toMatchObject({
      status: "requested",
      driver: "browser",
      sourceUrl: "/assets/payment-prompt.wav",
    });

    resolvePlay();
    await request;

    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      sourceUrl: "/assets/payment-prompt.wav",
    });
  });

  it("records browser playback failures as diagnostics", async () => {
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) =>
        new MockBrowserAudio(
          sourceUrl,
          Promise.reject(new Error("NotAllowedError")),
        ),
    });
    const playback = createMachineAudioPlayback({ driver });

    const played = await playback.playLocal("/assets/refund-pending.wav");

    expect(played).toBe(false);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "failed",
      driver: "browser",
      sourceUrl: "/assets/refund-pending.wav",
      message: "NotAllowedError",
    });
  });

  it("stops the current playback and records a stopped diagnostic", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/dispensing-started.wav");
    playback.stop();

    expect(driver.stops).toHaveLength(1);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "stopped",
      driver: "mock",
      sourceUrl: "/assets/dispensing-started.wav",
    });
  });

  it("stops and replaces the current playback when a new local audio starts", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/presence-greeting.wav");
    await playback.playLocal("/assets/payment-prompt.wav");

    expect(driver.stops).toHaveLength(1);
    expect(driver.requests).toEqual([
      { sourceUrl: "/assets/presence-greeting.wav", volume: 1 },
      { sourceUrl: "/assets/payment-prompt.wav", volume: 1 },
    ]);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "mock",
      sourceUrl: "/assets/payment-prompt.wav",
    });
  });

  it("stops and replaces pending driver playback before it reports started", async () => {
    let resolveFirstPlayback!: () => void;
    const firstPlaybackStarted = new Promise<void>((resolve) => {
      resolveFirstPlayback = resolve;
    });
    const created: MockBrowserAudio[] = [];
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) => {
        const audio = new MockBrowserAudio(
          sourceUrl,
          sourceUrl.includes("presence-greeting")
            ? firstPlaybackStarted
            : Promise.resolve(),
        );
        created.push(audio);
        return audio;
      },
    });
    const playback = createMachineAudioPlayback({ driver });

    const staleRequest = playback.playLocal("/assets/presence-greeting.wav");
    await playback.playLocal("/assets/payment-prompt.wav");
    resolveFirstPlayback();
    const stalePlayed = await staleRequest;
    created[0].emit("ended");

    expect(created).toHaveLength(2);
    expect(stalePlayed).toBe(false);
    expect(created[0].pause).toHaveBeenCalledTimes(1);
    expect(created[0].currentTime).toBe(0);
    expect(created[1].pause).not.toHaveBeenCalled();
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      sourceUrl: "/assets/payment-prompt.wav",
    });
  });

  it("records browser completion as a diagnostic only", async () => {
    const audio = new MockBrowserAudio("/assets/pickup-completed.wav");
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: () => audio,
    });
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/pickup-completed.wav");
    audio.emit("ended");

    expect(playback.latestDiagnostic()).toMatchObject({
      status: "completed",
      driver: "browser",
      sourceUrl: "/assets/pickup-completed.wav",
    });
  });

  it("lets tests complete mock playback without real audio hardware", async () => {
    const driver = createMockMachineAudioPlaybackDriver();
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/customer-thanks.wav");
    driver.completeActive();

    expect(playback.latestDiagnostic()).toMatchObject({
      status: "completed",
      driver: "mock",
      sourceUrl: "/assets/customer-thanks.wav",
    });
  });

  it("does not mutate transaction or readiness state when playback fails or completes", async () => {
    const checkoutStore = useCheckoutStore();
    const machineStore = useMachineStore();
    checkoutStore.applyTransaction(transaction());
    machineStore.applyHealth(healthyRuntimeSnapshot());
    applyReadyRuntime();
    const initialCheckout = checkoutObservation();
    const initialReadiness = readinessObservation();
    const completedAudio = new MockBrowserAudio("/assets/manual-handling.wav");
    const failedAudio = new MockBrowserAudio(
      "/assets/refund-pending.wav",
      Promise.reject(new Error("NotAllowedError")),
    );
    const driver = createBrowserMachineAudioPlaybackDriver({
      audioFactory: (sourceUrl) =>
        sourceUrl.includes("refund-pending") ? failedAudio : completedAudio,
    });
    const playback = createMachineAudioPlayback({ driver });

    await playback.playLocal("/assets/manual-handling.wav");
    completedAudio.emit("ended");
    await playback.playLocal("/assets/refund-pending.wav");

    expect(playback.latestDiagnostic()).toMatchObject({
      status: "failed",
      sourceUrl: "/assets/refund-pending.wav",
    });
    expect(checkoutObservation()).toEqual(initialCheckout);
    expect(readinessObservation()).toEqual(initialReadiness);
  });
});
