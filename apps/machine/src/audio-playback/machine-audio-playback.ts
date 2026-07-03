export type MachineAudioPlaybackDriverName = "browser" | "mock";

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
  driver: MachineAudioPlaybackDriver;
};

type MockMachineAudioPlaybackDriver = MachineAudioPlaybackDriver & {
  readonly requests: Array<{ sourceUrl: string }>;
  readonly stops: string[];
  completeActive(): void;
};

let requestSequence = 1;

export function createMachineAudioPlayback(
  options: MachineAudioPlaybackOptions,
): MachineAudioPlayback {
  let latestDiagnostic: MachineAudioPlaybackDiagnostic | null = null;
  let activePlayback: { requestId: string; sourceUrl: string } | null = null;

  async function playLocal(sourceUrl: string): Promise<boolean> {
    stop();
    const requestId = `machine-audio-playback-${requestSequence}`;
    requestSequence += 1;
    activePlayback = { requestId, sourceUrl };
    recordDiagnostic({
      requestId,
      status: "requested",
      sourceUrl,
    });
    try {
      await options.driver.playLocal(sourceUrl, {
        onCompleted: () => {
          if (activePlayback?.requestId !== requestId) return;
          activePlayback = null;
          recordDiagnostic({
            requestId,
            status: "completed",
            sourceUrl,
          });
        },
      });
      if (activePlayback?.requestId !== requestId) return false;
      recordDiagnostic({
        requestId,
        status: "started",
        sourceUrl,
      });
      return true;
    } catch (error) {
      if (activePlayback?.requestId !== requestId) return false;
      activePlayback = null;
      recordDiagnostic({
        requestId,
        status: "failed",
        sourceUrl,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function stop(): void {
    const stoppedPlayback = activePlayback;
    if (!stoppedPlayback) return;
    options.driver.stop();
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
    currentDriver: () => options.driver.name,
    latestDiagnostic: () => latestDiagnostic,
  };

  function recordDiagnostic(input: {
    requestId: string;
    status: MachineAudioPlaybackStatus;
    sourceUrl: string;
    message?: string | null;
  }): void {
    latestDiagnostic = {
      requestId: input.requestId,
      status: input.status,
      driver: options.driver.name,
      sourceUrl: input.sourceUrl,
      message: input.message ?? null,
      recordedAt: new Date().toISOString(),
    };
  }
}

export function createMockMachineAudioPlaybackDriver(): MockMachineAudioPlaybackDriver {
  const requests: Array<{ sourceUrl: string }> = [];
  const stops: string[] = [];
  let activePlayback: MachineAudioPlaybackDriverPlayOptions | null = null;
  return {
    name: "mock",
    requests,
    stops,
    async playLocal(
      sourceUrl: string,
      playOptions?: MachineAudioPlaybackDriverPlayOptions,
    ): Promise<void> {
      requests.push({ sourceUrl });
      activePlayback = playOptions ?? null;
    },
    stop(): void {
      activePlayback = null;
      stops.push(new Date().toISOString());
    },
    completeActive(): void {
      const completedPlayback = activePlayback;
      activePlayback = null;
      completedPlayback?.onCompleted?.();
    },
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
