import { beforeEach, describe, expect, it, vi } from "vitest";

const { callTauriCommandMock, isTauriRuntimeMock, listenMock } = vi.hoisted(
  () => ({
    callTauriCommandMock: vi.fn(),
    isTauriRuntimeMock: vi.fn(),
    listenMock: vi.fn(),
  }),
);

vi.mock("@/native/tauri", () => ({
  callTauriCommand: callTauriCommandMock,
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  createBrowserMachineAudioPlaybackDriver,
  createMachineAudioPlayback,
  createTauriNativeMachineAudioPlaybackDriver,
  type BrowserMachineAudioElement,
} from "./machine-audio-playback";

class MockBrowserAudio implements BrowserMachineAudioElement {
  readonly src: string;
  currentTime = 0;
  volume = 1;
  readonly play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  readonly pause = vi.fn<() => void>();

  constructor(src: string) {
    this.src = src;
  }

  addEventListener(): void {
    return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauriRuntimeMock.mockReturnValue(false);
  callTauriCommandMock.mockResolvedValue(undefined);
  listenMock.mockResolvedValue(vi.fn());
});

describe("Tauri native Machine Audio playback driver", () => {
  it("is unavailable outside the Tauri runtime", () => {
    expect(createTauriNativeMachineAudioPlaybackDriver()).toBeNull();
  });

  it("plays local audio through the Tauri native playback command", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const driver = createTauriNativeMachineAudioPlaybackDriver();

    await driver?.playLocal("/assets/payment-succeeded.wav", {
      requestId: "native-test-1",
      volume: 0.35,
    });

    expect(driver?.name).toBe("native");
    expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
      requestId: "native-test-1",
      sourceUrl: "/assets/payment-succeeded.wav",
      volume: 0.35,
    });
  });

  it("reports completion only after the matching native playback completion event", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const listeners = new Map<
      string,
      (event: { payload: { requestId: string } }) => void
    >();
    listenMock.mockImplementation(async (eventName, listener) => {
      listeners.set(eventName, listener);
      return vi.fn();
    });
    const diagnostics: string[] = [];
    const playback = createMachineAudioPlayback({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.status),
    });

    await playback.playLocal("/assets/payment-succeeded.wav");

    expect(diagnostics).toEqual(["requested", "started"]);
    listeners.get("machine-audio-completed")?.({
      payload: { requestId: "another-request" },
    });
    expect(diagnostics).toEqual(["requested", "started"]);

    const firstCall = callTauriCommandMock.mock.calls[0];
    if (!firstCall) throw new Error("native playback command was not called");
    const requestId = (firstCall[1] as { requestId: string }).requestId;
    listeners.get("machine-audio-completed")?.({ payload: { requestId } });

    expect(diagnostics).toEqual(["requested", "started", "completed"]);
  });

  it("reports a stopped terminal outcome only for the active native request", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const listeners = new Map<
      string,
      (event: { payload: { requestId: string; message?: string } }) => void
    >();
    listenMock.mockImplementation(async (eventName, listener) => {
      listeners.set(eventName, listener);
      return vi.fn();
    });
    const outcomes: string[] = [];
    const driver = createTauriNativeMachineAudioPlaybackDriver();

    await driver?.playLocal("/assets/payment-succeeded.wav", {
      requestId: "native-stop-1",
      volume: 0.7,
      onTerminal: (outcome) => outcomes.push(outcome.status),
    });
    const stopping = driver?.stop();

    listeners.get("machine-audio-stopped")?.({
      payload: { requestId: "another-request" },
    });
    listeners.get("machine-audio-stopped")?.({
      payload: { requestId: "native-stop-1" },
    });
    await stopping;

    expect(outcomes).toEqual(["stopped"]);
    expect(callTauriCommandMock).toHaveBeenCalledWith("stop_machine_audio", {
      requestId: "native-stop-1",
    });
  });

  it("lets every idempotent stop caller join the same native terminal wait", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const listeners = new Map<
      string,
      (event: { payload: { requestId: string; message?: string } }) => void
    >();
    listenMock.mockImplementation(async (eventName, listener) => {
      listeners.set(eventName, listener);
      return vi.fn();
    });
    const driver = createTauriNativeMachineAudioPlaybackDriver();
    await driver?.playLocal("/assets/payment-succeeded.wav", {
      requestId: "native-stop-join",
      volume: 0.7,
    });

    const firstStop = driver?.stop();
    const secondStop = driver?.stop();
    expect(secondStop).toBe(firstStop);
    let secondSettled = false;
    void Promise.resolve(secondStop).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(
      callTauriCommandMock.mock.calls.filter(
        ([command]) => command === "stop_machine_audio",
      ),
    ).toHaveLength(1);

    listeners.get("machine-audio-stopped")?.({
      payload: { requestId: "native-stop-join" },
    });
    await Promise.all([firstStop, secondStop]);
    expect(secondSettled).toBe(true);
  });

  it("waits for the matching native terminal event when stop races command acceptance", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const listeners = new Map<
      string,
      (event: { payload: { requestId: string; message?: string } }) => void
    >();
    listenMock.mockImplementation(async (eventName, listener) => {
      listeners.set(eventName, listener);
      return vi.fn();
    });
    let resolvePlay: (() => void) | null = null;
    callTauriCommandMock.mockImplementation((command: string) => {
      if (command === "play_machine_audio") {
        return new Promise<void>((resolve) => {
          resolvePlay = resolve;
        });
      }
      return Promise.resolve();
    });
    const outcomes: string[] = [];
    const driver = createTauriNativeMachineAudioPlaybackDriver();
    const starting = driver?.playLocal("/assets/payment-succeeded.wav", {
      requestId: "native-race-1",
      volume: 0.7,
      onTerminal: (outcome) => outcomes.push(outcome.status),
    });

    await vi.waitFor(() => {
      expect(listeners.get("machine-audio-stopped")).toBeTypeOf("function");
    });
    await vi.waitFor(() => {
      expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
        requestId: "native-race-1",
        sourceUrl: "/assets/payment-succeeded.wav",
        volume: 0.7,
      });
    });
    const stopping = driver?.stop();
    listeners.get("machine-audio-stopped")?.({
      payload: { requestId: "native-race-1" },
    });
    expect(outcomes).toEqual([]);

    const completeStart = resolvePlay as unknown as (() => void) | null;
    if (!completeStart) throw new Error("native play command did not start");
    completeStart();
    await starting;
    await stopping;

    expect(outcomes).toEqual(["stopped"]);
  });

  it("automatically prefers native playback in Tauri with browser fallback available", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const browserAudio = new MockBrowserAudio("/unused.wav");
    const playback = createMachineAudioPlayback({
      browserDriver: createBrowserMachineAudioPlaybackDriver({
        audioFactory: () => browserAudio,
      }),
    });

    const played = await playback.playLocal("/assets/payment-succeeded.wav");

    expect(played).toBe(true);
    expect(playback.currentDriver()).toBe("native");
    expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
      requestId: expect.any(String),
      sourceUrl: "/assets/payment-succeeded.wav",
      volume: 1,
    });
    expect(browserAudio.play).not.toHaveBeenCalled();
  });

  it("falls back to the default browser driver when automatic native playback fails", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    callTauriCommandMock.mockRejectedValueOnce(
      new Error("play_machine_audio failed: native output unavailable"),
    );
    const browserAudio = new MockBrowserAudio("/assets/refund-pending.wav");
    const audioFactory = vi.fn(function (_sourceUrl: string) {
      return browserAudio;
    });
    vi.stubGlobal("Audio", audioFactory);
    const playback = createMachineAudioPlayback({});

    const played = await playback.playLocal("/assets/refund-pending.wav");

    expect(played).toBe(true);
    expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
      requestId: expect.any(String),
      sourceUrl: "/assets/refund-pending.wav",
      volume: 1,
    });
    expect(audioFactory).toHaveBeenCalledWith("/assets/refund-pending.wav");
    expect(browserAudio.play).toHaveBeenCalledTimes(1);
    expect(playback.latestDiagnostic()).toMatchObject({
      status: "started",
      driver: "browser",
      message:
        "native playback degraded: play_machine_audio failed: native output unavailable",
    });
  });
});
