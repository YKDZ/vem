import { describe, expect, it, vi } from "vitest";

import type { CustomerJourneyTransition } from "@/customer-journey/transition-projector";
import type { MachineRuntimeAudioTraceEntry } from "@/runtime/machine-runtime-trace";

import {
  createAudioCoordinator,
  type AudioCoordinatorPlaybackDriver,
} from "./audio-coordinator";

function transition(
  transitionId: string,
  category: CustomerJourneyTransition["category"] = "transaction",
): CustomerJourneyTransition {
  return {
    transitionId,
    kind: category === "presence" ? "presence.welcome" : "payment.prompt",
    category,
    orderNo: "ORDER-1",
    occurredAt: "2026-07-18T08:00:00.000Z",
    productCategory: null,
  };
}

describe("Audio Coordinator", () => {
  it("keeps an accepted request active until its driver reports a terminal outcome", async () => {
    let completeActive: (() => void) | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        completeActive = () => options?.onTerminal?.({ status: "completed" });
      }),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: 20,
      }),
    });

    await coordinator.accept([transition("transition-1")]);
    await coordinator.accept([transition("transition-2")]);

    expect(driver.playLocal).toHaveBeenCalledTimes(1);
    expect(coordinator.activeRequest()?.transitionId).toBe("transition-1");
    expect(coordinator.queuedRequestIds()).toEqual(["audio-request-2"]);

    const complete = completeActive as (() => void) | null;
    if (!complete)
      throw new Error("mock playback did not retain its terminal callback");
    complete();
    await vi.waitFor(() => {
      expect(driver.playLocal).toHaveBeenCalledTimes(2);
    });

    expect(coordinator.activeRequest()?.transitionId).toBe("transition-2");
    expect(
      coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
    ).toEqual([
      expect.objectContaining({
        requestId: "audio-request-1",
        outcome: "completed",
      }),
    ]);
  });

  it("records one stopped outcome for every accepted request during runtime teardown", async () => {
    let stopActive: (() => void) | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        stopActive = () => options?.onTerminal?.({ status: "stopped" });
      }),
      stop: vi.fn(async () => stopActive?.()),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: 20,
      }),
    });

    await coordinator.accept([transition("transition-active")]);
    await coordinator.accept([transition("transition-queued")]);
    await coordinator.dispose();

    expect(
      coordinator
        .trace()
        .filter(
          (entry): entry is MachineRuntimeAudioTraceEntry =>
            entry.type === "audio_terminal",
        )
        .map((entry) => [entry.requestId, entry.outcome]),
    ).toEqual([
      ["audio-request-1", "stopped"],
      ["audio-request-2", "stopped"],
    ]);
  });

  it("waits for the interrupted request's stopped event before starting a higher priority request", async () => {
    let terminal:
      | ((status: "completed" | "failed" | "stopped") => void)
      | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        terminal = (status) => options?.onTerminal?.({ status });
      }),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: item.transitionId === "low" ? 10 : 100,
      }),
    });

    await coordinator.accept([transition("low")]);
    await coordinator.accept([transition("high")]);

    expect(driver.stop).toHaveBeenCalledOnce();
    expect(driver.playLocal).toHaveBeenCalledTimes(1);
    expect(coordinator.activeRequest()?.transitionId).toBe("low");

    const stopActive = terminal as
      | ((status: "completed" | "failed" | "stopped") => void)
      | null;
    if (!stopActive)
      throw new Error("mock playback did not retain terminal callback");
    stopActive("stopped");
    await vi.waitFor(() => {
      expect(driver.playLocal).toHaveBeenCalledTimes(2);
    });
    expect(coordinator.activeRequest()?.transitionId).toBe("high");
    expect(
      coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
    ).toEqual([
      expect.objectContaining({
        transitionId: "low",
        outcome: "stopped",
      }),
    ]);
  });

  it("deduplicates a stable transition identity and preserves its trace correlation", async () => {
    let complete: (() => void) | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        complete = () => options?.onTerminal?.({ status: "completed" });
      }),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: () => ({ sourceUrl: "/audio/payment.mp3", priority: 20 }),
    });

    await coordinator.accept([transition("stable-payment")]);
    await coordinator.accept([transition("stable-payment")]);
    expect(driver.playLocal).toHaveBeenCalledOnce();

    const finish = complete as (() => void) | null;
    if (!finish)
      throw new Error("mock playback did not retain terminal callback");
    finish();
    expect(
      coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
    ).toEqual([
      expect.objectContaining({
        transitionId: "stable-payment",
        requestId: "audio-request-1",
        outcome: "completed",
      }),
    ]);
  });

  it.each([
    [
      "global cues disabled",
      "transaction",
      {
        cuesEnabled: false,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
      0,
    ],
    [
      "presence cues disabled",
      "presence",
      {
        cuesEnabled: true,
        presenceCuesEnabled: false,
        transactionCuesEnabled: true,
      },
      0,
    ],
    [
      "transaction cues disabled",
      "transaction",
      {
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: false,
      },
      0,
    ],
    [
      "matching cues enabled",
      "presence",
      {
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
      1,
    ],
  ] as const)(
    "applies %s before accepting a request",
    async (_label, category, preferences, expectedStarts) => {
      const driver: AudioCoordinatorPlaybackDriver = {
        name: "mock",
        playLocal: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      };
      const coordinator = createAudioCoordinator({
        driver,
        preferences: () => ({ volume: 0.7, ...preferences }),
        mapTransition: () => ({ sourceUrl: "/audio/test.mp3", priority: 20 }),
      });

      await coordinator.accept([
        transition(`preference-${category}`, category),
      ]);

      expect(driver.playLocal).toHaveBeenCalledTimes(expectedStarts);
    },
  );

  it("uses the effective audio volume and rejects new transaction transitions after transaction cues are disabled", async () => {
    const effectiveAudioPreferences = {
      volume: 0.35,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    };
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => effectiveAudioPreferences,
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: 20,
      }),
    });

    await coordinator.accept([transition("payment-prompt")]);

    expect(driver.playLocal).toHaveBeenCalledWith(
      "/audio/payment-prompt.mp3",
      expect.objectContaining({ volume: 0.35 }),
    );

    effectiveAudioPreferences.transactionCuesEnabled = false;
    await coordinator.accept([transition("payment-succeeded")]);

    expect(driver.playLocal).toHaveBeenCalledOnce();
    expect(coordinator.trace()).toContainEqual(
      expect.objectContaining({
        type: "audio_rejected",
        transitionId: "payment-succeeded",
        message: "audio cue preference disabled",
      }),
    );
  });

  it("rejects a transition that has no presentation source", async () => {
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: () => null,
    });

    await coordinator.accept([transition("unmapped")]);

    expect(driver.playLocal).not.toHaveBeenCalled();
    expect(coordinator.queuedRequestIds()).toEqual([]);
  });

  it("bounds pending requests and traces the queue-full rejection", async () => {
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: 20,
      }),
      maxQueueSize: 1,
    });

    await coordinator.accept([transition("active")]);
    await coordinator.accept([transition("queued")]);
    await coordinator.accept([transition("rejected")]);

    expect(coordinator.queuedRequestIds()).toEqual(["audio-request-2"]);
    expect(coordinator.trace()).toContainEqual(
      expect.objectContaining({
        type: "audio_rejected",
        transitionId: "rejected",
        message: "audio queue full",
      }),
    );
  });

  it.each(["completed", "failed", "stopped"] as const)(
    "records %s as the one terminal outcome for an accepted request",
    async (status) => {
      let terminal: ((outcome: { status: typeof status }) => void) | null =
        null;
      const driver: AudioCoordinatorPlaybackDriver = {
        name: "mock",
        playLocal: vi.fn(async (_sourceUrl, options) => {
          terminal = (outcome) => options?.onTerminal?.(outcome);
        }),
        stop: vi.fn(async () => undefined),
      };
      const coordinator = createAudioCoordinator({
        driver,
        preferences: () => ({
          volume: 0.7,
          cuesEnabled: true,
          presenceCuesEnabled: true,
          transactionCuesEnabled: true,
        }),
        mapTransition: () => ({ sourceUrl: "/audio/test.mp3", priority: 20 }),
      });

      await coordinator.accept([transition(`terminal-${status}`)]);
      const finish = terminal as
        | ((outcome: { status: typeof status }) => void)
        | null;
      if (!finish)
        throw new Error("mock playback did not retain terminal callback");
      finish({ status });
      finish({ status });

      expect(
        coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
      ).toEqual([
        expect.objectContaining({
          transitionId: `terminal-${status}`,
          outcome: status,
        }),
      ]);
    },
  );

  it("routes Local Operations test playback through the same coordinator despite cue preferences", async () => {
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: false,
        presenceCuesEnabled: false,
        transactionCuesEnabled: false,
      }),
      mapTransition: () => null,
    });

    const requestId = await coordinator.requestTestPlayback(
      "/audio/maintenance-test.mp3",
      0.35,
    );

    expect(requestId).toBe("audio-request-1");
    expect(driver.playLocal).toHaveBeenCalledWith(
      "/audio/maintenance-test.mp3",
      {
        requestId,
        volume: 0.35,
        onTerminal: expect.any(Function),
      },
    );
  });

  it("gives Local Operations test playback maximum priority and waits to interrupt", async () => {
    let terminal:
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        terminal = (outcome) => options?.onTerminal?.(outcome);
      }),
      stop: vi.fn(async () => undefined),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: () => ({ sourceUrl: "/audio/normal.mp3", priority: 999 }),
    });

    await coordinator.accept([transition("normal")]);
    const testRequestId = await coordinator.requestTestPlayback(
      "/audio/maintenance-test.mp3",
      0.35,
    );

    expect(driver.stop).toHaveBeenCalledOnce();
    expect(driver.playLocal).toHaveBeenCalledOnce();
    expect(coordinator.activeRequest()?.transitionId).toBe("normal");

    const stopActive = terminal as
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null;
    if (!stopActive)
      throw new Error("mock playback did not retain terminal callback");
    stopActive({ status: "stopped" });
    await vi.waitFor(() => {
      expect(driver.playLocal).toHaveBeenCalledTimes(2);
    });
    expect(coordinator.activeRequest()?.requestId).toBe(testRequestId);
  });

  it("joins priority interruption and disposal on the same terminal outcome", async () => {
    let terminal:
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null = null;
    let resolveStop: (() => void) | null = null;
    const stopWait = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        terminal = (outcome) => options?.onTerminal?.(outcome);
      }),
      stop: vi.fn(() => stopWait),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: item.transitionId === "low" ? 10 : 100,
      }),
    });

    await coordinator.accept([transition("low")]);
    const interrupting = coordinator.accept([transition("high")]);
    await vi.waitFor(() => {
      expect(driver.stop).toHaveBeenCalledOnce();
    });
    const disposing = coordinator.dispose();
    expect(coordinator.dispose()).toBe(disposing);
    await vi.waitFor(() => {
      expect(driver.stop).toHaveBeenCalledTimes(2);
    });
    let disposalSettled = false;
    void disposing.then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    const finish = terminal as
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null;
    if (!finish)
      throw new Error("mock playback did not retain terminal callback");
    finish({ status: "stopped" });
    const releaseStop = resolveStop as (() => void) | null;
    if (!releaseStop) throw new Error("mock stop wait was not installed");
    releaseStop();
    await Promise.all([interrupting, disposing]);

    expect(driver.playLocal).toHaveBeenCalledOnce();
    expect(
      coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
    ).toEqual([
      expect.objectContaining({ transitionId: "low", outcome: "stopped" }),
      expect.objectContaining({ transitionId: "high", outcome: "stopped" }),
    ]);
  });

  it("terminalizes an interrupted request as failed when the stop command fails", async () => {
    let terminal:
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null = null;
    const driver: AudioCoordinatorPlaybackDriver = {
      name: "mock",
      playLocal: vi.fn(async (_sourceUrl, options) => {
        terminal = (outcome) => options?.onTerminal?.(outcome);
      }),
      stop: vi.fn(async () => {
        throw new Error("native stop unavailable");
      }),
    };
    const coordinator = createAudioCoordinator({
      driver,
      preferences: () => ({
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      }),
      mapTransition: (item) => ({
        sourceUrl: `/audio/${item.transitionId}.mp3`,
        priority: item.transitionId === "low" ? 10 : 100,
      }),
    });

    await coordinator.accept([transition("low")]);
    await coordinator.accept([transition("high")]);

    expect(
      coordinator.trace().filter((entry) => entry.type === "audio_terminal"),
    ).toEqual([
      expect.objectContaining({
        transitionId: "low",
        outcome: "failed",
        message: "native stop unavailable",
      }),
    ]);
    expect(driver.playLocal).toHaveBeenCalledTimes(2);
    const activeTerminal = terminal as
      | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
      | null;
    if (!activeTerminal)
      throw new Error("mock playback did not retain terminal callback");
    activeTerminal({ status: "completed" });
  });
});
