import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getConfig: getConfigMock,
  },
}));

import type { HealthSnapshot } from "@/daemon/schemas";

import { normalizeMachineConfig } from "@/config/machine-config";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";

import {
  createMachineAudioCuePlaybackAdapter,
  type BrowserAudioElement,
} from "./browser-playback";

class MockAudio implements BrowserAudioElement {
  readonly src: string;
  currentTime = 0;
  volume = 1;
  readonly play = vi.fn<() => Promise<void>>();
  readonly pause = vi.fn<() => void>();
  private listeners = new Map<string, Array<() => void>>();

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

function enableAudioCues(): void {
  useAudioCueStore().applySettings({
    enabled: true,
    categories: { presence: true, transaction: true },
  });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440020",
    orderNo: "ORD-AUDIO-FAIL-001",
    productSummary: null,
    paymentNo: "PAY-AUDIO-FAIL-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "manual_handling",
    totalAmountCents: 4900,
    vending: {
      commandNo: "CMD-AUDIO-FAIL-001",
      status: "result_unknown",
      lastError: "dispense result unknown",
    },
    nextAction: "manual_handling",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-29T08:02:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-29T08:02:01.000Z",
    ...overrides,
  };
}

function healthyRuntimeSnapshot(): HealthSnapshot {
  return {
    status: "healthy",
    process: {
      component: "process",
      level: "ok",
      code: "PROCESS_READY",
      message: "ready",
      updatedAt: "2026-06-29T08:02:00.000Z",
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
    updatedAt: "2026-06-29T08:02:00.000Z",
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
    updatedAt: "2026-06-29T08:02:00.000Z",
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
  return {
    flowStep: checkoutStore.flowStep,
    resultKind: checkoutStore.resultKind,
    nextAction: checkoutStore.status?.nextAction,
    paymentState: checkoutStore.status?.paymentState,
    fulfillmentState: checkoutStore.status?.fulfillmentState,
    paymentStatus: checkoutStore.status?.payment.status,
    vendingStatus: checkoutStore.status?.vending?.status,
    orderNo: checkoutStore.status?.orderNo,
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
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  setActivePinia(createPinia());
  vi.clearAllMocks();
  enableAudioCues();
});

describe("createMachineAudioCuePlaybackAdapter", () => {
  it("maps semantic presence cues to a browser audio source without caller asset paths", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:00:00.000Z",
      nowMs: 0,
    });

    expect(created).toHaveLength(1);
    expect(created[0].src).toContain("presence-detected");
  });

  it("uses loaded global Machine Audio volume for live browser cue playback", async () => {
    const config = normalizeMachineConfig({
      machineCode: "MACHINE-1",
      machineAudioVolume: 0.35,
      audioCueSettings: {
        enabled: true,
        categories: {
          presence: true,
          transaction: true,
        },
      },
    });
    getConfigMock.mockResolvedValue({
      public: {
        ...config,
        machineSecret: undefined,
        machineSecretConfigured: undefined,
        mqttSigningSecret: undefined,
        mqttSigningSecretConfigured: undefined,
        mqttPassword: undefined,
        mqttPasswordConfigured: undefined,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });

    await useMachineStore().loadConfig();
    await adapter.requestCustomerAudioCue({
      type: "payment.succeeded",
      orderKey: "ORDER-VOLUME-1",
      requestedAt: "2026-06-29T08:00:30.000Z",
    });

    expect(created).toHaveLength(1);
    expect(created[0].volume).toBe(0.35);
  });

  it("records playback start and completion diagnostics around pending browser playback", async () => {
    let resolvePlay!: () => void;
    const playStarted = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const audio = new MockAudio("unused", playStarted);
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => audio,
    });
    const store = useAudioCueStore();

    const playback = adapter.requestCustomerAudioCue({
      type: "payment.succeeded",
      orderKey: "ORDER-1",
      requestedAt: "2026-06-29T08:01:00.000Z",
    });

    expect(store.playback.status).toBe("playing");
    expect(store.latestPlaybackDiagnostic).toBeNull();

    resolvePlay();
    await playback;

    expect(store.playback.status).toBe("playing");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      outcome: "played",
    });

    audio.emit("ended");

    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      outcome: "completed",
    });
  });

  it.each([
    {
      cue: "refund.pending",
      snapshot: transaction({
        orderNo: "ORD-AUDIO-REFUND-001",
        paymentNo: "PAY-AUDIO-REFUND-001",
        paymentStatus: "refund_pending",
        orderStatus: "refund_pending",
        nextAction: "refund_pending",
        vending: {
          commandNo: "CMD-AUDIO-REFUND-001",
          status: "failed",
          lastError: "refund requested after dispense failure",
        },
      }),
    },
    {
      cue: "manual_handling.required",
      snapshot: transaction({
        orderNo: "ORD-AUDIO-MANUAL-001",
        paymentNo: "PAY-AUDIO-MANUAL-001",
        paymentStatus: "succeeded",
        orderStatus: "manual_handling",
        nextAction: "manual_handling",
        vending: {
          commandNo: "CMD-AUDIO-MANUAL-001",
          status: "result_unknown",
          lastError: "dispense result unknown",
        },
      }),
    },
  ] as const)(
    "records rejected $cue playback without mutating transaction or readiness state",
    async ({ cue, snapshot }) => {
      const checkoutStore = useCheckoutStore();
      const machineStore = useMachineStore();
      checkoutStore.applyTransaction(snapshot);
      machineStore.applyHealth(healthyRuntimeSnapshot());
      applyReadyRuntime();
      const initialCheckout = checkoutObservation();
      const initialReadiness = readinessObservation();
      const adapter = createMachineAudioCuePlaybackAdapter({
        audioFactory: () =>
          new MockAudio("unused", Promise.reject(new Error("NotAllowedError"))),
      });

      await adapter.requestCustomerAudioCue({
        type: cue,
        orderKey: snapshot.orderNo,
        requestedAt: "2026-06-29T08:02:01.000Z",
      });

      expect(useAudioCueStore().playback.status).toBe("idle");
      expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
        cueKey: cue,
        orderKey: snapshot.orderNo,
        outcome: "failed",
        message: "NotAllowedError",
      });
      expect(checkoutObservation()).toEqual(initialCheckout);
      expect(readinessObservation()).toEqual(initialReadiness);
      expect(useAudioCueStore().hasOrderCuePlayed(snapshot.orderNo, cue)).toBe(
        false,
      );
    },
  );

  it("lets manual handling outrank pending presence while dropping stale low-priority cues", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:00.000Z",
      nowMs: 1_000,
    });
    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:03.000Z",
      nowMs: 4_000,
    });

    expect(created).toHaveLength(0);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });

    await adapter.requestCustomerAudioCue({
      type: "manual_handling.required",
      orderKey: "ORDER-3",
      requestedAt: "2026-06-29T08:03:04.000Z",
      nowMs: 5_000,
    });

    expect(store.playback.request).toMatchObject({
      category: "transaction",
      cueKey: "manual_handling.required",
      orderKey: "ORDER-3",
    });
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });
  });

  it("suppresses duplicate presence cues during the central cooldown", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:10.000Z",
      nowMs: 50_000,
    });
    created[0].emit("ended");

    await expect(
      adapter.requestCustomerAudioCue({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:11.000Z",
        nowMs: 51_000,
      }),
    ).resolves.toBe(false);

    expect(created).toHaveLength(1);
    expect(useAudioCueStore().playback.status).toBe("idle");
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      category: "presence",
      cueKey: "presence.detected",
      orderKey: null,
      outcome: "skipped",
      message: "presence audio cue cooldown",
      recordedAt: "2026-06-29T08:03:11.000Z",
    });
  });

  it.each([
    [
      "global disabled setting",
      { enabled: false, categories: { presence: true, transaction: true } },
      "global audio cues disabled",
    ],
    [
      "category disabled setting",
      { enabled: true, categories: { presence: false, transaction: true } },
      "presence audio cue category disabled",
    ],
  ] as const)(
    "records the latest diagnostic when production presence cues are suppressed by %s",
    async (_settingName, settings, message) => {
      useAudioCueStore().applySettings(settings);
      const adapter = createMachineAudioCuePlaybackAdapter({
        audioFactory: () => new MockAudio("unused"),
      });

      await expect(
        adapter.requestCustomerAudioCue({
          type: "presence.detected",
          requestedAt: "2026-06-29T08:03:12.000Z",
          nowMs: 52_000,
        }),
      ).resolves.toBe(false);

      expect(useAudioCueStore().playback.status).toBe("idle");
      expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
        category: "presence",
        cueKey: "presence.detected",
        orderKey: null,
        outcome: "skipped",
        message,
        recordedAt: "2026-06-29T08:03:12.000Z",
      });
    },
  );

  it("preserves presence cooldown after dropping a stale pending presence cue", async () => {
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:20.000Z",
      nowMs: 1_000,
    });

    await expect(
      adapter.requestCustomerAudioCue({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:23.000Z",
        nowMs: 4_000,
      }),
    ).resolves.toBe(false);

    expect(adapter.pendingSourceCount()).toBe(0);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });

    await expect(
      adapter.requestCustomerAudioCue({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:30.000Z",
        nowMs: 11_000,
      }),
    ).resolves.toBe(true);

    expect(store.playback.request).toMatchObject({
      cueKey: "presence.detected",
    });
  });

  it("stops stale playing presence audio when cooldown suppresses its replacement", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:40.000Z",
      nowMs: 2_000,
    });
    created[0].currentTime = 1.75;

    await expect(
      adapter.requestCustomerAudioCue({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:43.000Z",
        nowMs: 5_000,
      }),
    ).resolves.toBe(false);

    expect(created).toHaveLength(1);
    expect(created[0].pause).toHaveBeenCalledOnce();
    expect(created[0].currentTime).toBe(0);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });
  });

  it("keeps lower priority transaction and presence cues from replacing pending failure cues", async () => {
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "dispense.failed",
      orderKey: "ORDER-4",
      requestedAt: "2026-06-29T08:04:00.000Z",
    });
    await adapter.requestCustomerAudioCue({
      type: "refund.pending",
      orderKey: "ORDER-4",
      requestedAt: "2026-06-29T08:04:01.000Z",
    });
    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:04:02.000Z",
    });

    expect(store.playback.request).toMatchObject({
      cueKey: "dispense.failed",
      orderKey: "ORDER-4",
    });
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "lower priority than dispense.failed",
    });
  });

  it("lets transaction progress cues outrank fresh presence cues", async () => {
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:05:00.000Z",
      nowMs: 10_000,
    });
    await adapter.requestCustomerAudioCue({
      type: "dispensing.started",
      orderKey: "ORDER-5",
      requestedAt: "2026-06-29T08:05:01.000Z",
      nowMs: 11_000,
    });

    expect(store.playback.request).toMatchObject({
      category: "transaction",
      cueKey: "dispensing.started",
      orderKey: "ORDER-5",
    });
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "replaced by dispensing.started",
    });
  });

  it("stops already-playing lower-priority browser audio before starting a priority replacement", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:06:00.000Z",
      nowMs: 20_000,
    });
    created[0].currentTime = 1.5;

    await adapter.requestCustomerAudioCue({
      type: "manual_handling.required",
      orderKey: "ORDER-6",
      requestedAt: "2026-06-29T08:06:01.000Z",
      nowMs: 21_000,
    });

    expect(created).toHaveLength(2);
    expect(created[0].pause).toHaveBeenCalledOnce();
    expect(created[0].currentTime).toBe(0);
    expect(created[1].src).toContain("manual-handling-required");
    expect(useAudioCueStore().playback.request).toMatchObject({
      cueKey: "manual_handling.required",
      orderKey: "ORDER-6",
    });
  });

  it("shares active playback ownership across separately created cue requesters", async () => {
    const presenceAudio: MockAudio[] = [];
    const transactionAudio: MockAudio[] = [];
    const presenceRequester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        presenceAudio.push(audio);
        return audio;
      },
    });
    const transactionRequester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        transactionAudio.push(audio);
        return audio;
      },
    });

    await presenceRequester.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:06:10.000Z",
      nowMs: 22_000,
    });
    presenceAudio[0].currentTime = 1.25;

    await transactionRequester.requestCustomerAudioCue({
      type: "dispense.failed",
      orderKey: "ORDER-6B",
      requestedAt: "2026-06-29T08:06:11.000Z",
      nowMs: 23_000,
    });

    expect(presenceAudio[0].pause).toHaveBeenCalledOnce();
    expect(presenceAudio[0].currentTime).toBe(0);
    expect(transactionAudio).toHaveLength(1);
    expect(transactionAudio[0].src).toContain("dispense-failed");
    expect(useAudioCueStore().playback.request).toMatchObject({
      cueKey: "dispense.failed",
      orderKey: "ORDER-6B",
    });
  });

  it("drops the source for a stale pending cue when cooldown suppresses its replacement", async () => {
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:00.000Z",
      nowMs: 30_000,
    });
    expect(adapter.pendingSourceCount()).toBe(1);

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:03.000Z",
      nowMs: 33_000,
    });

    expect(adapter.pendingSourceCount()).toBe(0);
  });

  it("drops the source for a pending cue when a higher-priority cue replaces it", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
      autoStart: false,
    });

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:10.000Z",
      nowMs: 35_000,
    });
    expect(adapter.pendingSourceCount()).toBe(1);

    await adapter.requestCustomerAudioCue({
      type: "dispense.failed",
      orderKey: "ORDER-7",
      requestedAt: "2026-06-29T08:07:11.000Z",
      nowMs: 36_000,
    });

    expect(adapter.pendingSourceCount()).toBe(1);
    await adapter.startPendingCue();
    expect(created).toHaveLength(1);
    expect(created[0].src).toContain("dispense-failed");
  });

  it("clears a deferred pending cue and its retained source", async () => {
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:08:00.000Z",
      nowMs: 40_000,
    });

    expect(adapter.pendingSourceCount()).toBe(1);
    expect(adapter.clearPendingCue("route changed")).toBe(true);

    expect(adapter.pendingSourceCount()).toBe(0);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "route changed",
    });
    await expect(adapter.startPendingCue()).resolves.toBe(false);
  });

  it("suppresses duplicate transaction cues remembered by the central audio cue store", async () => {
    const created: MockAudio[] = [];
    const adapter = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });
    const store = useAudioCueStore();

    await adapter.requestCustomerAudioCue({
      type: "payment.succeeded",
      orderKey: "ORDER-8",
      requestedAt: "2026-06-29T08:09:00.000Z",
    });
    created[0].emit("ended");

    expect(store.hasOrderCuePlayed("ORDER-8", "payment.succeeded")).toBe(true);

    await expect(
      adapter.requestCustomerAudioCue({
        type: "payment.succeeded",
        orderKey: "ORDER-8",
        requestedAt: "2026-06-29T08:09:01.000Z",
      }),
    ).resolves.toBe(false);

    expect(created).toHaveLength(1);
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-8",
      outcome: "skipped",
      message: "duplicate transaction cue",
    });
  });
});
