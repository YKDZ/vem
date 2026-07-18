import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRecordedVisionSiteConfiguration,
  parseVisionTryOnAcceptanceArgs,
  validateVisionProtocolEvidence,
} from "./vision-try-on-acceptance.mjs";

describe("vision try-on acceptance script", () => {
  it("accepts only full mode with absolute Windows inputs", () => {
    assert.deepEqual(
      parseVisionTryOnAcceptanceArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        "--handoff",
        "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        "--out",
        "C:\\ProgramData\\VEM\\testbed\\vision-try-on-acceptance.json",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        handoffPath:
          "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        outPath:
          "C:\\ProgramData\\VEM\\testbed\\vision-try-on-acceptance.json",
      },
    );
    assert.throws(
      () =>
        parseVisionTryOnAcceptanceArgs([
          "--mode",
          "fast",
          "--guest-input",
          "C:\\guest.json",
          "--handoff",
          "C:\\handoff.json",
          "--out",
          "C:\\out.json",
        ]),
      /--mode must be full/,
    );
  });

  it("builds recorded-video configuration for the installed Tauri origin", () => {
    const config = buildRecordedVisionSiteConfiguration();
    assert.equal(config.schemaVersion, "vending-vision-site-config/v1");
    assert.deepEqual(config.allowed_origins, [
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://127.0.0.1:7892",
    ]);
    assert.deepEqual(config.cameras.top, {
      source: "recorded_video",
      role: "presence",
      video_path: "recorded-video/top.mp4",
    });
    assert.deepEqual(config.cameras.front, {
      source: "recorded_video",
      role: "profile_tryon",
      video_path: "recorded-video/front.mp4",
    });
  });

  it("validates compact health and machine-protocol evidence", () => {
    const summary = validateVisionProtocolEvidence({
      health: {
        status: "ok",
        protocol: "vem.vision.v1",
        modelReady: true,
        cameraReady: true,
      },
      ready: {
        protocol: "vem.vision.v1",
        type: "vision.ready",
        messageId: "ready-1",
        timestamp: "2026-07-18T00:00:00.000Z",
        payload: {
          serverName: "vem-vision-runtime",
          serverVersion: "1.2.3",
          modelReady: true,
          cameraReady: true,
          capabilities: [
            "profile_push",
            "presence_status",
            "person_departed",
            "try_on_session",
          ],
        },
      },
      presence: {
        type: "vision.presence_status",
        payload: {
          detectedAt: "2026-07-18T00:00:01.000Z",
          personPresent: true,
        },
      },
      profile: {
        type: "vision.profile_result",
        payload: {
          detectedAt: "2026-07-18T00:00:02.000Z",
          profile: { personPresent: true },
          quality: { profileUsable: true },
        },
      },
      departure: {
        type: "vision.person_departed",
        payload: {
          detectedAt: "2026-07-18T00:00:03.000Z",
        },
      },
    });
    assert.deepEqual(summary, {
      healthStatus: "ok",
      readyServerName: "vem-vision-runtime",
      readyServerVersion: "1.2.3",
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "try_on_session",
      ],
      presenceDetectedAt: "2026-07-18T00:00:01.000Z",
      profileDetectedAt: "2026-07-18T00:00:02.000Z",
      departureDetectedAt: "2026-07-18T00:00:03.000Z",
      profileUsable: true,
    });
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "offline",
            protocol: "vem.vision.v1",
            modelReady: true,
            cameraReady: true,
          },
          ready: {},
          presence: {},
          profile: {},
          departure: {},
        }),
      /vision health evidence is invalid/,
    );
  });
});
