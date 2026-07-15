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
      outputDeviceId: "{0.0.0.00000000}.bound-speaker",
    });

    expect(driver?.name).toBe("native");
    expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
      requestId: "native-test-1",
      sourceUrl: "/assets/payment-succeeded.wav",
      volume: 0.35,
      outputDeviceId: "{0.0.0.00000000}.bound-speaker",
    });
  });

  it("reports completion only after the matching native playback completion event", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    let completionListener!: (event: {
      payload: { requestId: string };
    }) => void;
    listenMock.mockImplementation(async (_event, listener) => {
      completionListener = listener;
      return vi.fn();
    });
    const diagnostics: string[] = [];
    const playback = createMachineAudioPlayback({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.status),
    });

    await playback.playLocal("/assets/payment-succeeded.wav");

    expect(diagnostics).toEqual(["requested", "started"]);
    completionListener({ payload: { requestId: "another-request" } });
    expect(diagnostics).toEqual(["requested", "started"]);

    const requestId = (
      callTauriCommandMock.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;
    completionListener({ payload: { requestId } });

    expect(diagnostics).toEqual(["requested", "started", "completed"]);
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
