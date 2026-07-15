import { callTauriCommand, isTauriRuntime } from "@/native/tauri";

export type MachineAudioPlaybackDriverName = "browser" | "mock" | "native";

export type MachineAudioPlaybackStatus =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "stopped";

export type MachineAudioPlaybackDiagnostic = {
  requestId: string;
  status: MachineAudioPlaybackStatus;
  driver: MachineAudioPlaybackDriverName;
  sourceUrl: string;
  message: string | null;
  recordedAt: string;
};

type MachineAudioPlaybackDriverPlayOptions = {
  volume: number;
  outputDeviceId?: string | null;
  onCompleted?: () => void;
};

export type MachineAudioPlaybackDriver = {
  readonly name: MachineAudioPlaybackDriverName;
  /** Starts driver playback; callers may invoke stop() before this promise settles. */
  playLocal(
    sourceUrl: string,
    options?: MachineAudioPlaybackDriverPlayOptions,
  ): Promise<void>;
  /** Stops or cancels the driver's current pending or playing local audio. */
  stop(): void;
};

export type BrowserMachineAudioElement = {
  readonly src: string;
  currentTime: number;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(event: "ended", listener: () => void): void;
  addEventListener(event: string, listener: () => void): void;
};

type BrowserMachineAudioFactory = (
  sourceUrl: string,
) => BrowserMachineAudioElement;

type BrowserMachineAudioPlaybackDriverOptions = {
  audioFactory?: BrowserMachineAudioFactory;
};

export type MachineAudioPlayback = {
  playLocal(sourceUrl: string): Promise<boolean>;
  stop(): void;
  currentDriver(): MachineAudioPlaybackDriverName;
  latestDiagnostic(): MachineAudioPlaybackDiagnostic | null;
};

type MachineAudioPlaybackOptions = {
  driver?: MachineAudioPlaybackDriver;
  nativeDriver?: MachineAudioPlaybackDriver | null;
  browserDriver?: MachineAudioPlaybackDriver;
  volume?: number;
  outputDeviceId?: string | null;
  requireNativeOutputBinding?: boolean;
  onDiagnostic?: (diagnostic: MachineAudioPlaybackDiagnostic) => void;
};

type MockMachineAudioPlaybackDriver = MachineAudioPlaybackDriver & {
  readonly requests: Array<{
    sourceUrl: string;
    volume: number;
    outputDeviceId?: string | null;
  }>;
  readonly stops: string[];
  completeActive(): void;
};

type MockMachineAudioPlaybackDriverOptions = {
  name?: MachineAudioPlaybackDriverName;
  startDelayMs?: number;
  completeAfterMs?: number;
};

let requestSequence = 1;

export function createMachineAudioPlayback(
  options: MachineAudioPlaybackOptions,
): MachineAudioPlayback {
  let latestDiagnostic: MachineAudioPlaybackDiagnostic | null = null;
  let activePlayback: {
    requestId: string;
    sourceUrl: string;
    driver: MachineAudioPlaybackDriver;
  } | null = null;
  const volume = normalizePlaybackVolume(options.volume);
  const hasExplicitNativeDriver = Object.prototype.hasOwnProperty.call(
    options,
    "nativeDriver",
  );
  const shouldPreferNative =
    !options.driver && (hasExplicitNativeDriver || isTauriRuntime());
  const nativeDriver =
    !options.driver && hasExplicitNativeDriver
      ? options.nativeDriver
      : !options.driver && shouldPreferNative
        ? createTauriNativeMachineAudioPlaybackDriver()
        : undefined;
  const browserDriver =
    options.browserDriver ??
    (!options.driver ? createBrowserMachineAudioPlaybackDriver() : undefined);
  const requireNativeOutputBinding =
    options.requireNativeOutputBinding === true;
  const outputDeviceId = options.outputDeviceId ?? null;
  const nativePlaybackUnavailable =
    !options.driver &&
    shouldPreferNative &&
    nativeDriver === null &&
    Boolean(browserDriver);
  const selectedDriver = options.driver ?? nativeDriver ?? browserDriver;
  if (!selectedDriver) {
    throw new Error("Machine Audio Playback requires a playback driver");
  }
  const driver: MachineAudioPlaybackDriver = selectedDriver;
  let currentDriverName: MachineAudioPlaybackDriverName = driver.name;

  async function playLocal(sourceUrl: string): Promise<boolean> {
    stop();
    const requestId = `machine-audio-playback-${requestSequence}`;
    requestSequence += 1;
    activePlayback = { requestId, sourceUrl, driver };
    recordDiagnostic({
      requestId,
      status: "requested",
      sourceUrl,
    });
    if (
      requireNativeOutputBinding &&
      driver.name === "native" &&
      (!outputDeviceId || outputDeviceId.trim().length === 0)
    ) {
      activePlayback = null;
      recordDiagnostic({
        requestId,
        status: "failed",
        sourceUrl,
        driver: "native",
        message: "confirmed audio output binding is required",
      });
      return false;
    }
    if (nativePlaybackUnavailable) {
      const fallbackResult = await tryStartPlayback({
        driver,
        requestId,
        sourceUrl,
        message: "native playback degraded: native playback unavailable",
      });
      return fallbackResult.started;
    }
    const primaryResult = await tryStartPlayback({
      driver,
      requestId,
      sourceUrl,
    });
    if (primaryResult.started) return true;
    if (
      primaryResult.error &&
      driver.name === "native" &&
      browserDriver &&
      !requireNativeOutputBinding
    ) {
      activePlayback = {
        requestId,
        sourceUrl,
        driver: browserDriver,
      };
      const fallbackResult = await tryStartPlayback({
        driver: browserDriver,
        requestId,
        sourceUrl,
        message: `native playback degraded: ${primaryResult.error}`,
      });
      return fallbackResult.started;
    }
    return false;
  }

  async function tryStartPlayback(input: {
    driver: MachineAudioPlaybackDriver;
    requestId: string;
    sourceUrl: string;
    message?: string | null;
  }): Promise<{ started: boolean; error: string | null }> {
    currentDriverName = input.driver.name;
    try {
      await input.driver.playLocal(input.sourceUrl, {
        volume,
        outputDeviceId,
        onCompleted: () => {
          if (activePlayback?.requestId !== input.requestId) return;
          activePlayback = null;
          recordDiagnostic({
            requestId: input.requestId,
            status: "completed",
            sourceUrl: input.sourceUrl,
            driver: input.driver.name,
          });
        },
      });
      if (activePlayback?.requestId !== input.requestId) {
        return { started: false, error: null };
      }
      recordDiagnostic({
        requestId: input.requestId,
        status: "started",
        sourceUrl: input.sourceUrl,
        message: input.message,
        driver: input.driver.name,
      });
      return { started: true, error: null };
    } catch (error) {
      if (activePlayback?.requestId !== input.requestId) {
        return { started: false, error: null };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        input.driver.name === "native" &&
        browserDriver &&
        !requireNativeOutputBinding
      ) {
        return { started: false, error: message };
      }
      activePlayback = null;
      recordDiagnostic({
        requestId: input.requestId,
        status: "failed",
        sourceUrl: input.sourceUrl,
        message: input.message ? `${input.message}; ${message}` : message,
        driver: input.driver.name,
      });
      return { started: false, error: message };
    }
  }

  function stop(): void {
    const stoppedPlayback = activePlayback;
    if (!stoppedPlayback) return;
    stoppedPlayback.driver.stop();
    activePlayback = null;
    recordDiagnostic({
      requestId: stoppedPlayback.requestId,
      status: "stopped",
      sourceUrl: stoppedPlayback.sourceUrl,
    });
  }

  return {
    playLocal,
    stop,
    currentDriver: () => currentDriverName,
    latestDiagnostic: () => latestDiagnostic,
  };

  function recordDiagnostic(input: {
    requestId: string;
    status: MachineAudioPlaybackStatus;
    sourceUrl: string;
    driver?: MachineAudioPlaybackDriverName;
    message?: string | null;
  }): void {
    latestDiagnostic = {
      requestId: input.requestId,
      status: input.status,
      driver: input.driver ?? currentDriverName,
      sourceUrl: input.sourceUrl,
      message: input.message ?? null,
      recordedAt: new Date().toISOString(),
    };
    options.onDiagnostic?.(latestDiagnostic);
  }
}

export function createMockMachineAudioPlaybackDriver(
  input:
    | MachineAudioPlaybackDriverName
    | MockMachineAudioPlaybackDriverOptions = "mock",
): MockMachineAudioPlaybackDriver {
  const options =
    typeof input === "string"
      ? { name: input }
      : {
          name: input.name ?? "mock",
          startDelayMs: input.startDelayMs,
          completeAfterMs: input.completeAfterMs,
        };
  const requests: Array<{
    sourceUrl: string;
    volume: number;
    outputDeviceId?: string | null;
  }> = [];
  const stops: string[] = [];
  let activePlayback: MachineAudioPlaybackDriverPlayOptions | null = null;
  function completeActive(): void {
    const completedPlayback = activePlayback;
    activePlayback = null;
    completedPlayback?.onCompleted?.();
  }
  return {
    name: options.name,
    requests,
    stops,
    async playLocal(
      sourceUrl: string,
      playOptions?: MachineAudioPlaybackDriverPlayOptions,
    ): Promise<void> {
      const request = {
        sourceUrl,
        volume: playOptions?.volume ?? 1,
        outputDeviceId: playOptions?.outputDeviceId ?? null,
      };
      requests.push(
        request.outputDeviceId
          ? request
          : { sourceUrl: request.sourceUrl, volume: request.volume },
      );
      if (options.startDelayMs && options.startDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.startDelayMs);
        });
      }
      activePlayback = playOptions ?? null;
      if (options.completeAfterMs && options.completeAfterMs > 0) {
        setTimeout(() => {
          completeActive();
        }, options.completeAfterMs);
      }
    },
    stop(): void {
      activePlayback = null;
      stops.push(new Date().toISOString());
    },
    completeActive,
  };
}

export function createBrowserMachineAudioPlaybackDriver(
  options: BrowserMachineAudioPlaybackDriverOptions = {},
): MachineAudioPlaybackDriver {
  const audioFactory = options.audioFactory ?? defaultBrowserAudioFactory;
  let activeAudio: BrowserMachineAudioElement | null = null;

  return {
    name: "browser",
    async playLocal(
      sourceUrl: string,
      playOptions?: MachineAudioPlaybackDriverPlayOptions,
    ): Promise<void> {
      const audio = audioFactory(sourceUrl);
      activeAudio = audio;
      audio.volume = playOptions?.volume ?? 1;
      audio.addEventListener("ended", () => {
        if (activeAudio !== audio) return;
        activeAudio = null;
        playOptions?.onCompleted?.();
      });
      await audio.play();
    },
    stop(): void {
      if (!activeAudio) return;
      activeAudio.pause();
      activeAudio.currentTime = 0;
      activeAudio = null;
    },
  };
}

function defaultBrowserAudioFactory(
  sourceUrl: string,
): BrowserMachineAudioElement {
  return new Audio(sourceUrl);
}

export function createTauriNativeMachineAudioPlaybackDriver(): MachineAudioPlaybackDriver | null {
  if (!isTauriRuntime()) return null;
  return {
    name: "native",
    async playLocal(
      sourceUrl: string,
      playOptions?: MachineAudioPlaybackDriverPlayOptions,
    ): Promise<void> {
      await callTauriCommand<void>("play_machine_audio", {
        sourceUrl,
        volume: playOptions?.volume ?? 1,
        outputDeviceId: playOptions?.outputDeviceId ?? undefined,
      });
    },
    stop(): void {
      void callTauriCommand<void>("stop_machine_audio").catch(() => undefined);
    },
  };
}

function normalizePlaybackVolume(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(1, Math.max(0, numericValue));
}
