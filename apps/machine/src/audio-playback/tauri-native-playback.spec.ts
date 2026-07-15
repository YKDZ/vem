import { beforeEach, describe, expect, it, vi } from "vitest";

const { callTauriCommandMock, isTauriRuntimeMock } = vi.hoisted(() => ({
  callTauriCommandMock: vi.fn(),
  isTauriRuntimeMock: vi.fn(),
}));

vi.mock("@/native/tauri", () => ({
  callTauriCommand: callTauriCommandMock,
  isTauriRuntime: isTauriRuntimeMock,
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
});

describe("Tauri native Machine Audio playback driver", () => {
  it("is unavailable outside the Tauri runtime", () => {
    expect(createTauriNativeMachineAudioPlaybackDriver()).toBeNull();
  });

  it("plays local audio through the Tauri native playback command", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const driver = createTauriNativeMachineAudioPlaybackDriver();

    await driver?.playLocal("/assets/payment-succeeded.wav", {
      volume: 0.35,
      outputDeviceId: "{0.0.0.00000000}.bound-speaker",
    });

    expect(driver?.name).toBe("native");
    expect(callTauriCommandMock).toHaveBeenCalledWith("play_machine_audio", {
      sourceUrl: "/assets/payment-succeeded.wav",
      volume: 0.35,
      outputDeviceId: "{0.0.0.00000000}.bound-speaker",
    });
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
