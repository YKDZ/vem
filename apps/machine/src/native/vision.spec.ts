import { afterEach, describe, expect, it } from "vitest";

import { normalizeMachineConfig } from "@/config/machine-config";

import {
  startMockVisionServer,
  type MockVisionScenario,
  type MockVisionServer,
} from "../../../vision-mock/src/server";
import {
  subscribeVisionProfiles,
  type VisionPersonDepartedPayload,
  type VisionPresenceStatusPayload,
  type VisionProfileResultPayload,
  visionSelfCheck,
} from "./vision";

const servers: MockVisionServer[] = [];

afterEach(async () => {
  const closing = servers.splice(0).map(async (server) => {
    try {
      await server.close();
    } catch {
      return;
    }
  });
  await Promise.all(closing);
});

async function startVisionMock(
  scenario: MockVisionScenario = "success",
): Promise<string> {
  const server = startMockVisionServer({
    port: 0,
    scenario,
    pushIntervalMs: 1,
  });
  servers.push(server);
  return await server.ready;
}

async function waitForPushedProfile(
  url: string,
): Promise<VisionProfileResultPayload> {
  const config = normalizeMachineConfig({ visionWsUrl: url });
  return await new Promise((resolve, reject) => {
    let subscription: ReturnType<typeof subscribeVisionProfiles>;
    subscription = subscribeVisionProfiles(config, {
      onProfile: (payload) => {
        subscription.close();
        resolve(payload);
      },
      onError: (error) => {
        subscription.close();
        reject(error);
      },
    });
  });
}

describe("vision native browser fallback - self-check", () => {
  it("performs self-check against the mock websocket server", async () => {
    const url = await startVisionMock();
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await visionSelfCheck(config);

    expect(result.online).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.ready?.serverName).toBe("vem-vision-mock");
    expect(result.ready?.cameraReady).toBe(true);
    expect(result.ready?.modelReady).toBe(true);
    expect(typeof result.checkedAtMs).toBe("number");
  });

  it("returns enabled=false when vision is disabled in config", async () => {
    const config = normalizeMachineConfig({ visionEnabled: false });

    const result = await visionSelfCheck(config);

    expect(result.enabled).toBe(false);
    expect(result.online).toBe(false);
  });

  it("returns online=false when server is not reachable", async () => {
    const config = normalizeMachineConfig({
      visionWsUrl: "ws://127.0.0.1:19999/ws",
    });

    await expect(visionSelfCheck(config)).rejects.toThrow();
  });
});

describe("vision native browser fallback - pushed profiles", () => {
  it("receives a pushed presence event before profile details", async () => {
    const url = await startVisionMock("success");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await new Promise<VisionPresenceStatusPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onPresenceStatus: (payload) => {
            subscription.close();
            resolve(payload);
          },
          onProfile: () => undefined,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      },
    );

    expect(result.state).toBe("approach");
    expect(result.personPresent).toBe(true);
    expect(typeof result.detectedAt).toBe("string");
  });

  it("receives a pushed profile from the mock websocket server", async () => {
    const url = await startVisionMock("success");

    const result = await waitForPushedProfile(url);

    expect(typeof result.eventId).toBe("string");
    expect(result.profile.personPresent).toBe(true);
    expect(result.profile.heightCm).toBe(172);
    expect(result.quality.overall).toBe("fair");
    expect(typeof result.detectedAt).toBe("string");
  });

  it("receives a pushed departure event from the mock websocket server", async () => {
    const url = await startVisionMock("departure_after_presence");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await new Promise<VisionPersonDepartedPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onPresenceStatus: () => undefined,
          onPersonDeparted: (payload) => {
            subscription.close();
            resolve(payload);
          },
          onProfile: () => undefined,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      },
    );

    expect(result.reason).toBe("left_frame");
    expect(result.lastSeenAt).toBeTruthy();
    expect(result.ambientLight?.level).toBe("bright");
  });

  it("keeps waiting silently when no person is detected", async () => {
    const url = await startVisionMock("no_person");
    const config = normalizeMachineConfig({ visionWsUrl: url });
    let pushed = false;
    let failed = false;

    const subscription = subscribeVisionProfiles(config, {
      onProfile: () => {
        pushed = true;
      },
      onError: () => {
        failed = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.close();

    expect(pushed).toBe(false);
    expect(failed).toBe(false);
  });

  it("reports pushed camera_unavailable errors", async () => {
    const url = await startVisionMock("camera_unavailable");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    await expect(
      new Promise((resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onProfile: resolve,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      }),
    ).rejects.toThrow("vision camera_unavailable:");
  });

  it("reconnects after the websocket closes", async () => {
    const url = await startVisionMock("disconnect_once");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await new Promise<VisionProfileResultPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles> = {
          close: () => undefined,
        };
        const timeout = setTimeout(() => {
          subscription.close();
          reject(new Error("waiting for reconnected profile timed out"));
        }, 5000);
        subscription = subscribeVisionProfiles(config, {
          onProfile: (payload) => {
            clearTimeout(timeout);
            subscription.close();
            resolve(payload);
          },
          onError: () => undefined,
        });
      },
    );

    expect(result.profile.personPresent).toBe(true);
    expect(result.profile.heightCm).toBe(172);
  }, 10_000);
});

describe("vision native browser fallback - vision disabled", () => {
  it("does not open a subscription when vision is disabled", () => {
    const config = normalizeMachineConfig({ visionEnabled: false });
    let status: string | null = null;

    const subscription = subscribeVisionProfiles(config, {
      onProfile: () => undefined,
      onStatus: (message) => {
        status = message;
      },
    });

    subscription.close();
    expect(status).toBe("视觉模块未启用");
  });
});
