import { afterEach, describe, expect, it } from "vitest";

import { normalizeMachineConfig } from "@/config/machine-config";

import {
  startMockVisionServer,
  type MockVisionScenario,
  type MockVisionServer,
} from "../../../vision-mock/src/server";
import { requestVisionProfile, visionSelfCheck } from "./vision";

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
    responseDelayMs: 1,
  });
  servers.push(server);
  return await server.ready;
}

describe("vision native browser fallback — self-check", () => {
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

describe("vision native browser fallback — requestVisionProfile success", () => {
  it("requests a profile from the mock websocket server", async () => {
    const url = await startVisionMock("success");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await requestVisionProfile(config, {
      sessionId: "machine-browser-test",
      trigger: "test",
      timeoutMs: 5000,
    });

    expect(result.sessionId).toBe("machine-browser-test");
    expect(result.profile.personPresent).toBe(true);
    expect(result.profile.heightCm).toBe(172);
    expect(result.quality.overall).toBe("good");
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.completedAt).toBe("string");
  });

  it("uses default requested fields when not specified", async () => {
    const url = await startVisionMock("success");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    const result = await requestVisionProfile(config, {
      sessionId: "default-fields-test",
      timeoutMs: 5000,
    });

    expect(result.profile.personPresent).toBe(true);
  });
});

describe("vision native browser fallback — no_person scenario", () => {
  it("throws an error when no person is detected", async () => {
    const url = await startVisionMock("no_person");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    await expect(
      requestVisionProfile(config, {
        sessionId: "no-person-test",
        trigger: "test",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("vision no_person:");
  });
});

describe("vision native browser fallback — camera_unavailable scenario", () => {
  it("throws an error when camera is unavailable", async () => {
    const url = await startVisionMock("camera_unavailable");
    const config = normalizeMachineConfig({ visionWsUrl: url });

    await expect(
      requestVisionProfile(config, {
        sessionId: "camera-unavailable-test",
        trigger: "test",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("vision camera_unavailable:");
  });
});

describe("vision native browser fallback — vision disabled", () => {
  it("throws when vision is disabled", async () => {
    const config = normalizeMachineConfig({ visionEnabled: false });

    await expect(
      requestVisionProfile(config, {
        sessionId: "disabled-test",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("vision module is disabled");
  });
});
