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

import type {
  HealthSnapshot,
  NaturalContextSnapshot,
  TransactionSnapshot,
} from "@/daemon/schemas";

import {
  createMachineAudioPlayback,
  createMockMachineAudioPlaybackDriver,
  type MachineAudioPlayback,
  type MachineAudioPlaybackDiagnostic,
  type MachineAudioPlaybackDriver,
} from "@/audio-playback/machine-audio-playback";
import { normalizeMachineConfig } from "@/config/machine-config";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useNaturalContextStore } from "@/stores/natural-context";

import { createMachineAudioCuePlaybackAdapter } from "./browser-playback";

type MockPlaybackDriver = ReturnType<
  typeof createMockMachineAudioPlaybackDriver
>;

type CapturedPlayback = {
  driver: MockPlaybackDriver | MachineAudioPlaybackDriver;
  playback: MachineAudioPlayback;
  diagnostics: MachineAudioPlaybackDiagnostic[];
};

type NaturalContextWeather = NonNullable<
  NaturalContextSnapshot["externalEnvironment"]["weather"]
>;
type NaturalContextCalendar = NonNullable<
  NaturalContextSnapshot["externalEnvironment"]["calendar"]
>;

function createPlaybackHarness(
  driverFactory: () => MachineAudioPlaybackDriver = () =>
    createMockMachineAudioPlaybackDriver(),
): {
  created: CapturedPlayback[];
  playbackFactory: (options: {
    volume: number;
    outputDeviceId: string | null;
    requireNativeOutputBinding: boolean;
    onDiagnostic: (diagnostic: MachineAudioPlaybackDiagnostic) => void;
  }) => MachineAudioPlayback;
} {
  const created: CapturedPlayback[] = [];
  return {
    created,
    playbackFactory: (options) => {
      const driver = driverFactory();
      const diagnostics: MachineAudioPlaybackDiagnostic[] = [];
      const playback = createMachineAudioPlayback({
        driver,
        volume: options.volume,
        outputDeviceId: options.outputDeviceId,
        requireNativeOutputBinding: options.requireNativeOutputBinding,
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
          options.onDiagnostic(diagnostic);
        },
      });
      created.push({ driver, playback, diagnostics });
      return playback;
    },
  };
}

function failingPlaybackDriver(message: string): MachineAudioPlaybackDriver {
  return {
    name: "mock",
    async playLocal(): Promise<void> {
      throw new Error(message);
    },
    stop: vi.fn<() => void>(),
  };
}

function mockDriver(playback: CapturedPlayback): MockPlaybackDriver {
  return playback.driver as MockPlaybackDriver;
}

function enableAudioCues(): void {
  useAudioCueStore().applySettings({
    enabled: true,
    categories: { presence: true, transaction: true },
  });
}

function applyNaturalContext(input: {
  checkedAt?: string;
  temperatureCelsius?: number;
  weatherConditionClasses?: NaturalContextWeather["weatherConditionClasses"];
  primaryFestival?: NaturalContextCalendar["primaryFestival"];
  solarTerm?: NaturalContextCalendar["solarTerm"];
  localDate?: string;
}): void {
  const checkedAt = input.checkedAt ?? "2026-06-29T08:00:00.000Z";
  useNaturalContextStore().applySnapshot({
    status: "ready",
    machineCode: "MACHINE-AUDIO",
    checkedAt,
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: {
      status: "ready",
      machineCode: "MACHINE-AUDIO",
      checkedAt,
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: input.localDate ?? checkedAt.slice(0, 10),
        localClock: "16:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: input.temperatureCelsius ?? 28,
        conditionText: "小雨",
        conditionCode: "305",
        observedAt: checkedAt,
        weatherConditionClasses: input.weatherConditionClasses ?? ["other"],
        primaryWeatherConditionClass:
          input.weatherConditionClasses?.[0] ?? "other",
      },
      sun: {
        status: "ready",
        sunriseAt: "2026-06-28T21:53:00.000Z",
        sunsetAt: "2026-06-29T10:02:00.000Z",
      },
      calendar: {
        status: "ready",
        localDate: input.localDate ?? checkedAt.slice(0, 10),
        festivals: input.primaryFestival ? [input.primaryFestival] : [],
        primaryFestival: input.primaryFestival ?? null,
        solarTerm: input.solarTerm ?? null,
      },
    },
    localSiteSignals: {
      status: "unknown",
    },
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

function transaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440020",
    orderNo: "ORD-AUDIO-FAIL-001",
    productSummary: null,
    paymentId: null,
    paymentNo: "PAY-AUDIO-FAIL-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "manual_handling",
    totalAmountCents: 4900,
    vending: {
      commandId: null,
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
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  setActivePinia(createPinia());
  vi.clearAllMocks();
  enableAudioCues();
});

describe("createMachineAudioCuePlaybackAdapter", () => {
  it("maps semantic presence cues to a Machine Audio Playback source without caller asset paths", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:00:00.000Z",
      nowMs: 0,
    });

    expect(playback.created).toHaveLength(1);
    expect(mockDriver(playback.created[0]).requests[0].sourceUrl).toContain(
      "presence-detected",
    );
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
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await useMachineStore().loadConfig();
    await adapter.handleCustomerEvent({
      type: "payment.succeeded",
      orderKey: "ORDER-VOLUME-1",
      requestedAt: "2026-06-29T08:00:30.000Z",
    });

    expect(playback.created).toHaveLength(1);
    expect(mockDriver(playback.created[0]).requests[0].volume).toBe(0.35);
  });

  it("selects festival voice variants for ordinary welcome events from daemon-owned Natural Context", async () => {
    applyNaturalContext({
      primaryFestival: "dragon_boat_festival",
    });
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "presence.welcome.day",
      requestedAt: "2026-06-29T08:00:10.000Z",
      nowMs: 10_000,
    });

    expect(mockDriver(playback.created[0]).requests[0].sourceUrl).toBe(
      "/audio/voice/easter_egg/festival/dragon_boat.mp3",
    );
  });

  it("selects solar-term voice variants for local awakened events from Natural Context", async () => {
    applyNaturalContext({
      solarTerm: "start_of_spring",
    });
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "interaction.awakened",
      requestedAt: "2026-06-29T08:00:10.000Z",
      nowMs: 10_000,
    });

    expect(mockDriver(playback.created[0]).requests[0].sourceUrl).toBe(
      "/audio/voice/easter_egg/solar_term/start_of_spring.mp3",
    );
  });

  it("selects weather-specific departure voice assets from Natural Context classes", async () => {
    applyNaturalContext({
      temperatureCelsius: 24,
      weatherConditionClasses: ["moderate_or_heavy_rain"],
    });
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "departure.bad_weather",
      requestedAt: "2026-06-29T08:00:20.000Z",
      nowMs: 20_000,
    });

    expect(mockDriver(playback.created[0]).requests[0].sourceUrl).toBe(
      "/audio/voice/departure/bad_weather/heavy_rain.mp3",
    );
  });

  it("records cue playback as played while preserving completion as playback-only diagnostics", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });
    const store = useAudioCueStore();

    const request = adapter.handleCustomerEvent({
      type: "payment.succeeded",
      orderKey: "ORDER-1",
      requestedAt: "2026-06-29T08:01:00.000Z",
    });

    await request;

    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      outcome: "played",
    });

    mockDriver(playback.created[0]).completeActive();

    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      outcome: "played",
    });
    const diagnostics = playback.created[0].diagnostics;
    expect(diagnostics[diagnostics.length - 1]).toMatchObject({
      status: "completed",
      driver: "mock",
    });
  });

  it("delegates autonomous cue playback to the native-capable Machine Audio Playback path", async () => {
    getConfigMock.mockResolvedValue({
      public: {
        ...normalizeMachineConfig({
          machineCode: "MACHINE-NATIVE",
          audioCueSettings: {
            enabled: true,
            categories: {
              presence: true,
              transaction: true,
            },
          },
          machineAudioOutputBinding: {
            endpointId: "{0.0.0.00000000}.bound-speaker",
            friendlyName: "Near-field speaker",
            confirmedHeardAt: "2026-07-15T06:00:00.000Z",
          },
        }),
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });
    const nativeDriver = createMockMachineAudioPlaybackDriver("native");
    const browserDriver = createMockMachineAudioPlaybackDriver("browser");
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: (options) =>
        createMachineAudioPlayback({
          nativeDriver,
          browserDriver,
          volume: options.volume,
          outputDeviceId: options.outputDeviceId,
          requireNativeOutputBinding: options.requireNativeOutputBinding,
          onDiagnostic: options.onDiagnostic,
        }),
    });

    await useMachineStore().loadConfig();
    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:01:30.000Z",
      nowMs: 30_000,
    });

    expect(nativeDriver.requests).toHaveLength(1);
    expect(nativeDriver.requests[0].sourceUrl).toContain("presence-detected");
    expect(nativeDriver.requests[0].outputDeviceId).toBe(
      "{0.0.0.00000000}.bound-speaker",
    );
    expect(browserDriver.requests).toHaveLength(0);
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "played",
    });
  });

  it("rejects customer cue playback in native runtime until a confirmed output binding exists", async () => {
    getConfigMock.mockResolvedValue({
      public: {
        ...normalizeMachineConfig({
          machineCode: "MACHINE-NATIVE",
          audioCueSettings: {
            enabled: true,
            categories: {
              presence: true,
              transaction: true,
            },
          },
        }),
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });
    const nativeDriver = createMockMachineAudioPlaybackDriver("native");
    const browserDriver = createMockMachineAudioPlaybackDriver("browser");
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: (options) =>
        createMachineAudioPlayback({
          nativeDriver,
          browserDriver,
          volume: options.volume,
          outputDeviceId: options.outputDeviceId,
          requireNativeOutputBinding: options.requireNativeOutputBinding,
          onDiagnostic: options.onDiagnostic,
        }),
    });

    await useMachineStore().loadConfig();
    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:01:30.000Z",
      nowMs: 30_000,
    });

    expect(nativeDriver.requests).toHaveLength(0);
    expect(browserDriver.requests).toHaveLength(0);
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "failed",
      message: "confirmed audio output binding is required",
    });
  });

  it("does not let native-started transaction cues suppress later lower-priority cues forever", async () => {
    const nativeDriver = createMockMachineAudioPlaybackDriver("native");
    const browserDriver = createMockMachineAudioPlaybackDriver("browser");
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: (options) =>
        createMachineAudioPlayback({
          nativeDriver,
          browserDriver,
          volume: options.volume,
          onDiagnostic: options.onDiagnostic,
        }),
    });

    await adapter.handleCustomerEvent({
      type: "manual_handling.required",
      orderKey: "ORDER-NATIVE-1",
      requestedAt: "2026-06-29T08:01:31.000Z",
      nowMs: 31_000,
    });

    expect(useAudioCueStore().playback.status).toBe("idle");

    await expect(
      adapter.handleCustomerEvent({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:01:40.000Z",
        nowMs: 40_000,
      }),
    ).resolves.toBe(true);

    expect(nativeDriver.requests).toHaveLength(2);
    expect(nativeDriver.requests[1].sourceUrl).toContain("presence-detected");
    expect(browserDriver.requests).toHaveLength(0);
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "played",
    });
  });

  it.each([
    {
      cue: "refund.pending",
      snapshot: transaction({
        orderNo: "ORD-AUDIO-REFUND-001",
        paymentId: null,
        paymentNo: "PAY-AUDIO-REFUND-001",
        paymentStatus: "refund_pending",
        orderStatus: "refund_pending",
        nextAction: "refund_pending",
        vending: {
          commandId: null,
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
        paymentId: null,
        paymentNo: "PAY-AUDIO-MANUAL-001",
        paymentStatus: "succeeded",
        orderStatus: "manual_handling",
        nextAction: "manual_handling",
        vending: {
          commandId: null,
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
      const playback = createPlaybackHarness(() =>
        failingPlaybackDriver("NotAllowedError"),
      );
      const adapter = createMachineAudioCuePlaybackAdapter({
        playbackFactory: playback.playbackFactory,
      });

      await adapter.handleCustomerEvent({
        type: cue,
        orderKey: snapshot.orderNo,
        requestedAt: "2026-06-29T08:02:01.000Z",
      });
      const orderKey = snapshot.orderNo;
      expect(orderKey).not.toBeNull();
      if (!orderKey)
        throw new Error("transaction fixture must include orderNo");

      expect(useAudioCueStore().playback.status).toBe("idle");
      expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
        cueKey: cue,
        orderKey,
        outcome: "failed",
        message: "NotAllowedError",
      });
      expect(checkoutObservation()).toEqual(initialCheckout);
      expect(readinessObservation()).toEqual(initialReadiness);
      expect(useAudioCueStore().hasOrderCuePlayed(orderKey, cue)).toBe(false);
    },
  );

  it("lets manual handling outrank pending presence while dropping stale low-priority cues", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:00.000Z",
      nowMs: 1_000,
    });
    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:03.000Z",
      nowMs: 4_000,
    });

    expect(playback.created).toHaveLength(0);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });

    await adapter.handleCustomerEvent({
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
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:10.000Z",
      nowMs: 50_000,
    });
    mockDriver(playback.created[0]).completeActive();

    await expect(
      adapter.handleCustomerEvent({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:11.000Z",
        nowMs: 51_000,
      }),
    ).resolves.toBe(false);

    expect(playback.created).toHaveLength(1);
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
      const playback = createPlaybackHarness();
      const adapter = createMachineAudioCuePlaybackAdapter({
        playbackFactory: playback.playbackFactory,
      });

      await expect(
        adapter.handleCustomerEvent({
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
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:20.000Z",
      nowMs: 1_000,
    });

    await expect(
      adapter.handleCustomerEvent({
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
      adapter.handleCustomerEvent({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:30.000Z",
        nowMs: 11_000,
      }),
    ).resolves.toBe(true);

    expect(store.playback.request).toMatchObject({
      cueKey: "presence.detected",
    });
  });

  it("stops stale playing presence playback when cooldown suppresses its replacement", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:03:40.000Z",
      nowMs: 2_000,
    });
    await expect(
      adapter.handleCustomerEvent({
        type: "presence.detected",
        requestedAt: "2026-06-29T08:03:43.000Z",
        nowMs: 5_000,
      }),
    ).resolves.toBe(false);

    expect(playback.created).toHaveLength(1);
    expect(mockDriver(playback.created[0]).stops).toHaveLength(1);
    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "presence audio cue cooldown",
    });
  });

  it("keeps lower priority transaction and presence cues from replacing pending failure cues", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "dispense.failed",
      orderKey: "ORDER-4",
      requestedAt: "2026-06-29T08:04:00.000Z",
    });
    await adapter.handleCustomerEvent({
      type: "refund.pending",
      orderKey: "ORDER-4",
      requestedAt: "2026-06-29T08:04:01.000Z",
    });
    await adapter.handleCustomerEvent({
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
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:05:00.000Z",
      nowMs: 10_000,
    });
    await adapter.handleCustomerEvent({
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

  it("stops already-playing lower-priority generic playback before starting a priority replacement", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:06:00.000Z",
      nowMs: 20_000,
    });
    await adapter.handleCustomerEvent({
      type: "manual_handling.required",
      orderKey: "ORDER-6",
      requestedAt: "2026-06-29T08:06:01.000Z",
      nowMs: 21_000,
    });

    expect(playback.created).toHaveLength(2);
    expect(mockDriver(playback.created[0]).stops).toHaveLength(1);
    expect(mockDriver(playback.created[1]).requests[0].sourceUrl).toBe(
      "/audio/voice/error/hardware_fault.mp3",
    );
    expect(useAudioCueStore().playback.status).toBe("idle");
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "manual_handling.required",
      orderKey: "ORDER-6",
      outcome: "played",
    });
  });

  it("shares active playback ownership across separately created cue requesters", async () => {
    const presencePlayback = createPlaybackHarness();
    const transactionPlayback = createPlaybackHarness();
    const presenceRequester = createMachineAudioCuePlaybackAdapter({
      playbackFactory: presencePlayback.playbackFactory,
    });
    const transactionRequester = createMachineAudioCuePlaybackAdapter({
      playbackFactory: transactionPlayback.playbackFactory,
    });

    await presenceRequester.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:06:10.000Z",
      nowMs: 22_000,
    });
    await transactionRequester.handleCustomerEvent({
      type: "dispense.failed",
      orderKey: "ORDER-6B",
      requestedAt: "2026-06-29T08:06:11.000Z",
      nowMs: 23_000,
    });

    expect(mockDriver(presencePlayback.created[0]).stops).toHaveLength(1);
    expect(transactionPlayback.created).toHaveLength(1);
    expect(
      mockDriver(transactionPlayback.created[0]).requests[0].sourceUrl,
    ).toBe("/audio/voice/error/dispense_failed.mp3");
    expect(useAudioCueStore().playback.status).toBe("idle");
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "dispense.failed",
      orderKey: "ORDER-6B",
      outcome: "played",
    });
  });

  it("drops the source for a stale pending cue when cooldown suppresses its replacement", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:00.000Z",
      nowMs: 30_000,
    });
    expect(adapter.pendingSourceCount()).toBe(1);

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:03.000Z",
      nowMs: 33_000,
    });

    expect(adapter.pendingSourceCount()).toBe(0);
  });

  it("drops the source for a pending cue when a higher-priority cue replaces it", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });

    await adapter.handleCustomerEvent({
      type: "presence.detected",
      requestedAt: "2026-06-29T08:07:10.000Z",
      nowMs: 35_000,
    });
    expect(adapter.pendingSourceCount()).toBe(1);

    await adapter.handleCustomerEvent({
      type: "dispense.failed",
      orderKey: "ORDER-7",
      requestedAt: "2026-06-29T08:07:11.000Z",
      nowMs: 36_000,
    });

    expect(adapter.pendingSourceCount()).toBe(1);
    await adapter.startPendingCue();
    expect(playback.created).toHaveLength(1);
    expect(mockDriver(playback.created[0]).requests[0].sourceUrl).toBe(
      "/audio/voice/error/dispense_failed.mp3",
    );
  });

  it("clears a deferred pending cue and its retained source", async () => {
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
      autoStart: false,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
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
    const playback = createPlaybackHarness();
    const adapter = createMachineAudioCuePlaybackAdapter({
      playbackFactory: playback.playbackFactory,
    });
    const store = useAudioCueStore();

    await adapter.handleCustomerEvent({
      type: "payment.succeeded",
      orderKey: "ORDER-8",
      requestedAt: "2026-06-29T08:09:00.000Z",
    });
    mockDriver(playback.created[0]).completeActive();

    expect(store.hasOrderCuePlayed("ORDER-8", "payment.succeeded")).toBe(true);

    await expect(
      adapter.handleCustomerEvent({
        type: "payment.succeeded",
        orderKey: "ORDER-8",
        requestedAt: "2026-06-29T08:09:01.000Z",
      }),
    ).resolves.toBe(false);

    expect(playback.created).toHaveLength(1);
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      cueKey: "payment.succeeded",
      orderKey: "ORDER-8",
      outcome: "skipped",
      message: "duplicate transaction cue",
    });
  });
});
