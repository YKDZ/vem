import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import {
  buildRecordedVisionSiteConfiguration,
  combineCleanupFailure,
  compareObservedVisionProtocolToExpected,
  normalizeSeededVisionAcceptance,
  normalizeVisionExpectedResults,
  collectVisionProtocolEvidence,
  parseVisionTryOnAcceptanceArgs,
  startVisionMockScenario,
  stopVisionChild,
  validateRecommendationProjection,
  validateTryOnPresentation,
  validateVisionInstalledBinding,
  validateVisionProtocolEvidence,
  waitForVisionPortRelease,
} from "./vision-try-on-acceptance.mjs";

function queuedReader(queue, timestamps) {
  let index = 0;
  return async () => {
    const entry = queue[index++];
    if (!entry) {
      throw new Error("vision protocol message queue exhausted");
    }
    const timestamp = timestamps[index - 1] ?? new Date().toISOString();
    return { ...entry, timestamp };
  };
}

function visionProtocolMessage(type, payload) {
  return {
    protocol: "vem.vision.v1",
    type,
    messageId: `${type}-${Math.random()}`,
    payload,
  };
}

function baseExpectedResults() {
  return {
    schemaVersion: "vending-vision-expected-results/v1",
    protocol: {
      ready: { protocol: "vem.vision.v1" },
      presence: {
        type: "vision.presence_status",
        source: "top",
      },
      profile: {
        type: "vision.profile_result",
        source: "front",
      },
      departure: {
        type: "vision.person_departed",
        source: "top",
      },
    },
    recommendation: {
      minimumScore: 0.6,
    },
    tryOn: {},
  };
}

function frameSourceBinding() {
  return {
    adapter: "recorded_video",
    configSha256: "a".repeat(64),
    top: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\top.mp4",
      sha256: "b".repeat(64),
    },
    front: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\front.mp4",
      sha256: "c".repeat(64),
    },
    expectedResults: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\expected-results.json",
      sha256: "d".repeat(64),
    },
  };
}

function sourceFrame(role, fixtureSha256, overrides = {}) {
  return {
    adapter: "recorded_video",
    role,
    configSha256: "a".repeat(64),
    fixtureSha256,
    frameIndex: 3,
    decodedFrameCount: 4,
    synthetic: false,
    relabeled: false,
    ...overrides,
  };
}

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
        "--fixture-key",
        "visionExperience",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        handoffPath:
          "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        outPath: "C:\\ProgramData\\VEM\\testbed\\vision-try-on-acceptance.json",
        fixtureKey: "visionExperience",
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
        frameSource: frameSourceBinding(),
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
          frameSource: frameSourceBinding(),
        },
      },
      presence: {
        type: "vision.presence_status",
        payload: {
          source: "top",
          detectedAt: "2026-07-18T00:00:01.000Z",
          personPresent: true,
          sourceFrame: sourceFrame("top", "b".repeat(64)),
        },
      },
      profile: {
        type: "vision.profile_result",
        payload: {
          source: "front",
          detectedAt: "2026-07-18T00:00:02.000Z",
          profile: { personPresent: true },
          quality: { profileUsable: true },
          sourceFrame: sourceFrame("front", "c".repeat(64), {
            frameIndex: 8,
            decodedFrameCount: 9,
          }),
        },
      },
      departure: {
        type: "vision.person_departed",
        payload: {
          source: "top",
          detectedAt: "2026-07-18T00:00:03.000Z",
          sourceFrame: sourceFrame("top", "b".repeat(64), {
            frameIndex: 12,
            decodedFrameCount: 13,
          }),
        },
      },
    });
    assert.equal(summary.healthStatus, "ok");
    assert.equal(summary.readyServerName, "vem-vision-runtime");
    assert.equal(summary.readyServerVersion, "1.2.3");
    assert.deepEqual(summary.frameSourceBinding, frameSourceBinding());
    assert.equal(summary.profileUsable, true);
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "offline",
            protocol: "vem.vision.v1",
            modelReady: true,
            cameraReady: true,
            frameSource: frameSourceBinding(),
          },
          ready: {},
          presence: {},
          profile: {},
          departure: {},
        }),
      /vision health evidence is invalid/,
    );
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "ok",
            protocol: "vem.vision.v1",
            modelReady: true,
            cameraReady: true,
            frameSource: frameSourceBinding(),
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
              frameSource: frameSourceBinding(),
            },
          },
          presence: {
            type: "vision.presence_status",
            payload: {
              detectedAt: "2026-07-18T00:00:01.000Z",
              personPresent: true,
              sourceFrame: sourceFrame("top", "b".repeat(64)),
            },
          },
          profile: {
            type: "vision.profile_result",
            payload: {
              source: "front",
              detectedAt: "2026-07-18T00:00:02.000Z",
              profile: { personPresent: true },
              quality: {},
              sourceFrame: sourceFrame("front", "c".repeat(64)),
            },
          },
          departure: {
            type: "vision.person_departed",
            payload: {
              source: "top",
              detectedAt: "2026-07-18T00:00:03.000Z",
              sourceFrame: sourceFrame("top", "b".repeat(64), {
                frameIndex: 6,
                decodedFrameCount: 7,
              }),
            },
          },
        }),
      /vision profile evidence is invalid/,
    );
  });

  it("accepts missing frameSource when installed binding is supplied", () => {
    const binding = frameSourceBinding();
    const summary = validateVisionProtocolEvidence(
      {
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
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
            personPresent: true,
            sourceFrame: sourceFrame("top", "b".repeat(64)),
          },
        },
        profile: {
          type: "vision.profile_result",
          payload: {
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
            profile: { personPresent: true },
            quality: { profileUsable: true },
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 8,
              decodedFrameCount: 9,
            }),
          },
        },
        departure: {
          type: "vision.person_departed",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
            sourceFrame: sourceFrame("top", "b".repeat(64), {
              frameIndex: 12,
              decodedFrameCount: 13,
            }),
          },
        },
      },
      { frameSourceBinding: binding },
    );
    assert.deepEqual(summary.frameSourceBinding, binding);
  });

  it("fails when neither health/ready nor installed binding provides frameSource", () => {
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
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
              source: "top",
              detectedAt: "2026-07-18T00:00:01.000Z",
              personPresent: true,
              sourceFrame: sourceFrame("top", "b".repeat(64)),
            },
          },
          profile: {
            type: "vision.profile_result",
            payload: {
              source: "front",
              detectedAt: "2026-07-18T00:00:02.000Z",
              profile: { personPresent: true },
              quality: { profileUsable: true },
              sourceFrame: sourceFrame("front", "c".repeat(64), {
                frameIndex: 8,
                decodedFrameCount: 9,
              }),
            },
          },
          departure: {
            type: "vision.person_departed",
            payload: {
              source: "top",
              detectedAt: "2026-07-18T00:00:03.000Z",
              sourceFrame: sourceFrame("top", "b".repeat(64), {
                frameIndex: 12,
                decodedFrameCount: 13,
              }),
            },
          },
        }),
      /Vision frame-source binding is unavailable for protocol evidence/,
    );
  });

  it("normalizes fixture protocol semantics separately from seeded runtime identity", () => {
    const normalized = normalizeVisionExpectedResults(baseExpectedResults());
    assert.equal(normalized.protocol.profile.source, "front");
    assert.equal(normalized.recommendation.selectedVariantId, null);
    assert.equal(normalized.recommendation.orderedCatalogKeys, null);
    assert.equal(
      normalized.tryOn.previewPathPrefix,
      "http://127.0.0.1:7892/try-on/",
    );
    assert.deepEqual(
      normalizeSeededVisionAcceptance({
        selectedVariantId: "variant-seeded",
        tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnSilhouettePublicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        seededTryOnVariants: [
          {
            sourceRow: 31,
            productId: "product-seeded",
            variantId: "variant-seeded",
            sku: "TSC-LOCAL-031",
            size: "M",
            silhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
            silhouettePublicUrl:
              "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
          },
        ],
      }),
      {
        tryOnCategoryKey: null,
        selectedCatalogKey: null,
        selectedVariantId: "variant-seeded",
        tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnSilhouettePublicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        seededTryOnVariants: [
          {
            sourceRow: 31,
            productId: "product-seeded",
            variantId: "variant-seeded",
            sku: "TSC-LOCAL-031",
            size: "M",
            silhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
            silhouettePublicUrl:
              "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
          },
        ],
      },
    );
    assert.throws(
      () =>
        normalizeVisionExpectedResults({
          protocol: {},
          recommendation: {},
          tryOn: {},
        }),
      /presence expected result/,
    );
  });

  it("consumes the current Vision repository recorded-video fixture contract", () => {
    const normalized = normalizeVisionExpectedResults({
      schemaVersion: "vending-vision-recorded-video-fixture/v1",
      recordings: {
        top: { file: "top.mp4", sha256: "a".repeat(64), loop: false },
        front: { file: "front.mp4", sha256: "b".repeat(64), loop: true },
      },
      expected: {
        top: {
          protocolEvents: ["vision.presence_status", "vision.person_departed"],
        },
        front: { tryOn: { jpeg: true } },
      },
    });

    assert.equal(normalized.protocol.presence.type, "vision.presence_status");
    assert.equal(normalized.protocol.profile.type, "vision.profile_result");
    assert.equal(normalized.protocol.departure.type, "vision.person_departed");
  });

  it("compares observed protocol evidence by event type and fresh runtime chronology", () => {
    const summary = compareObservedVisionProtocolToExpected({
      expectedResults: baseExpectedResults(),
      protocolEvidence: {
        health: {
          status: "ok",
          protocol: "vem.vision.v1",
          modelReady: true,
          cameraReady: true,
          frameSource: frameSourceBinding(),
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
            frameSource: frameSourceBinding(),
          },
        },
        observation: {
          startedAt: "2026-07-18T00:00:00.500Z",
          completedAt: "2026-07-18T00:00:04.000Z",
        },
        presence: {
          type: "vision.presence_status",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
            personPresent: true,
            sourceFrame: sourceFrame("top", "b".repeat(64)),
          },
        },
        profile: {
          type: "vision.profile_result",
          payload: {
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
            profile: { personPresent: true },
            quality: { profileUsable: true },
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 6,
              decodedFrameCount: 7,
            }),
          },
        },
        departure: {
          type: "vision.person_departed",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
            sourceFrame: sourceFrame("top", "b".repeat(64), {
              frameIndex: 8,
              decodedFrameCount: 9,
            }),
          },
        },
      },
      installedBinding: { frameSourceBinding: frameSourceBinding() },
    });
    assert.equal(summary.expectedSequence[1].source, "front");
    assert.equal(summary.observationCompletedAt, "2026-07-18T00:00:04.000Z");
    assert.throws(
      () =>
        compareObservedVisionProtocolToExpected({
          expectedResults: baseExpectedResults(),
          protocolEvidence: {
            health: {
              status: "ok",
              protocol: "vem.vision.v1",
              modelReady: true,
              cameraReady: true,
              frameSource: frameSourceBinding(),
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
                frameSource: frameSourceBinding(),
              },
            },
            observation: {
              startedAt: "2026-07-18T00:00:00.500Z",
              completedAt: "2026-07-18T00:00:04.000Z",
            },
            presence: {
              type: "vision.presence_status",
              payload: {
                detectedAt: "2026-07-18T00:00:01.000Z",
                personPresent: false,
                sourceFrame: sourceFrame("front", "c".repeat(64)),
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2026-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
                sourceFrame: sourceFrame("front", "c".repeat(64), {
                  frameIndex: 4,
                  decodedFrameCount: 5,
                }),
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2026-07-18T00:00:03.000Z",
                sourceFrame: sourceFrame("top", "b".repeat(64), {
                  frameIndex: 6,
                  decodedFrameCount: 7,
                }),
              },
            },
          },
        }),
      /vision presence evidence is invalid/,
    );
    assert.throws(
      () =>
        compareObservedVisionProtocolToExpected({
          expectedResults: baseExpectedResults(),
          protocolEvidence: {
            health: {
              status: "ok",
              protocol: "vem.vision.v1",
              modelReady: true,
              cameraReady: true,
              frameSource: frameSourceBinding(),
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
                frameSource: frameSourceBinding(),
              },
            },
            observation: {
              startedAt: "2026-07-18T00:00:00.500Z",
              completedAt: "2026-07-18T00:00:04.000Z",
            },
            presence: {
              type: "vision.presence_status",
              payload: {
                source: "top",
                detectedAt: "2025-07-18T00:00:01.000Z",
                personPresent: true,
                sourceFrame: sourceFrame("top", "b".repeat(64)),
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2025-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
                sourceFrame: sourceFrame("front", "c".repeat(64), {
                  frameIndex: 4,
                  decodedFrameCount: 5,
                }),
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2025-07-18T00:00:03.000Z",
                sourceFrame: sourceFrame("top", "b".repeat(64), {
                  frameIndex: 6,
                  decodedFrameCount: 7,
                }),
              },
            },
          },
        }),
      /does not look fresh/,
    );
  });

  it("collects the first true presence event without requiring a non-contract source field", async () => {
    const closeArguments = [];
    const messages = [
      visionProtocolMessage("vision.ready", {
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
        frameSource: frameSourceBinding(),
      }),
      visionProtocolMessage("vision.presence_status", {
        source: "top",
        detectedAt: "2026-07-18T00:00:01.000Z",
        personPresent: false,
        sourceFrame: sourceFrame("top", "b".repeat(64)),
      }),
      visionProtocolMessage("vision.presence_status", {
        source: "front",
        detectedAt: "2026-07-18T00:00:01.500Z",
        personPresent: false,
        sourceFrame: sourceFrame("front", "c".repeat(64), {
          frameIndex: 3,
          decodedFrameCount: 4,
        }),
      }),
      visionProtocolMessage("vision.presence_status", {
        detectedAt: "2026-07-18T00:00:02.000Z",
        personPresent: true,
        sourceFrame: sourceFrame("top", "b".repeat(64), {
          frameIndex: 4,
          decodedFrameCount: 5,
        }),
      }),
      visionProtocolMessage("vision.profile_result", {
        source: "front",
        detectedAt: "2026-07-18T00:00:03.000Z",
        profile: { personPresent: true },
        quality: { profileUsable: true },
        sourceFrame: sourceFrame("front", "c".repeat(64), {
          frameIndex: 6,
          decodedFrameCount: 7,
        }),
      }),
      visionProtocolMessage("vision.person_departed", {
        source: "top",
        detectedAt: "2026-07-18T00:00:04.000Z",
        sourceFrame: sourceFrame("top", "b".repeat(64), {
          frameIndex: 8,
          decodedFrameCount: 9,
        }),
      }),
    ];

    const evidence = await collectVisionProtocolEvidence({
      machineCode: "MACHINE-01",
      openSocket: async () => ({
        send: () => {},
        close: (...args) => closeArguments.push(args),
      }),
      readMessage: queuedReader(messages, [
        "2026-07-18T00:00:00.100Z",
        "2026-07-18T00:00:01.000Z",
        "2026-07-18T00:00:01.500Z",
        "2026-07-18T00:00:02.000Z",
        "2026-07-18T00:00:03.000Z",
        "2026-07-18T00:00:04.000Z",
      ]),
      fetchHealth: async () => ({
        status: "ok",
        protocol: "vem.vision.v1",
        modelReady: true,
        cameraReady: true,
        frameSource: frameSourceBinding(),
      }),
      now: () => "2026-07-18T00:00:00.999Z",
      timeoutMs: 20_000,
    });

    assert.equal(evidence.presence.payload.personPresent, true);
    assert.equal(
      evidence.presence.payload.detectedAt,
      "2026-07-18T00:00:02.000Z",
    );
    assert.equal(evidence.observedMessages[1]?.type, "vision.presence_status");
    assert.equal(
      evidence.observedMessages[1]?.timestamp,
      "2026-07-18T00:00:01.000Z",
    );
    assert.equal(evidence.observedMessages[2]?.type, "vision.presence_status");
    assert.equal(evidence.presence.payload.sourceFrame.frameIndex, 4);
    assert.deepEqual(closeArguments, [[]]);

    const summary = compareObservedVisionProtocolToExpected({
      expectedResults: baseExpectedResults(),
      protocolEvidence: evidence,
      installedBinding: { frameSourceBinding: frameSourceBinding() },
    });

    assert.equal(summary.profileUsable, true);
  });

  it("fails closed unless recommendation changes and the seeded variant matches", () => {
    const summary = validateRecommendationProjection({
      beforeProducts: [
        {
          catalogKey: "product:M",
          preferredVariantId: "",
          recommendationScore: 0,
        },
        {
          catalogKey: "product:L",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      afterProducts: [
        {
          catalogKey: "product:L",
          preferredVariantId: "variant-l",
          recommendationScore: 0.88,
        },
        {
          catalogKey: "product:M",
          preferredVariantId: "",
          recommendationScore: 0.12,
        },
      ],
      pageText: "推荐商品 基础T恤",
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        seededTryOnVariants: [
          { productId: "L", variantId: "variant-l" },
          { productId: "M", variantId: "variant-m" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-l");
    assert.equal(summary.seededSelection.catalogKey, "product:L");
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "variant-x",
              recommendationScore: 0.9,
            },
          ],
          pageText: "推荐商品",
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            seededTryOnVariants: [{ productId: "L", variantId: "variant-l" }],
          },
        }),
      /must uniquely match exactly one seeded try-on entry/,
    );
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "variant-m",
              recommendationScore: 0.9,
            },
          ],
          pageText: "identity hidden? no, identity leaked",
          expectedResults: baseExpectedResults(),
        }),
      /did not actually change|leaked identity field/,
    );
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:X",
              preferredVariantId: "variant-l",
              recommendationScore: 0.9,
            },
          ],
          pageText: "推荐商品",
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            seededTryOnVariants: [{ productId: "L", variantId: "variant-l" }],
          },
        }),
      /catalogKey does not match the seeded productId/,
    );
  });

  it("keeps profile and try-on acceptance usable when published fixtures do not claim recommendation data", () => {
    const expectedResults = {
      schemaVersion: "vending-vision-recorded-video-fixture/v1",
      expected: {
        top: {
          protocolEvents: ["vision.presence_status", "vision.person_departed"],
        },
        front: { tryOn: { jpeg: true } },
      },
    };
    assert.equal(
      normalizeVisionExpectedResults(expectedResults).recommendation.required,
      false,
    );
    const summary = validateRecommendationProjection({
      beforeProducts: [
        {
          catalogKey: "product:regular",
          variantId: "variant-regular",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      afterProducts: [
        {
          catalogKey: "product:regular",
          variantId: "variant-regular",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      pageText: "常规码 T恤",
      expectedResults,
      runtimeExpectation: {
        seededTryOnVariants: [
          { productId: "regular", variantId: "variant-regular" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-regular");
  });

  it("requires decodable try-on pixels without requiring transport-specific frame headers", () => {
    const summary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: "product:L",
        variantId: "variant-l",
      },
      tryOnState: {
        route: "#/products/product:L/try-on?variantId=variant-l",
        previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
        silhouetteUrl:
          "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        silhouetteLoaded: true,
        silhouetteNaturalWidth: 640,
        silhouetteNaturalHeight: 1280,
      },
      mjpegEvidence: {
        contentType: "multipart/x-mixed-replace; boundary=frame",
        frameByteLength: 2048,
        width: 640,
        height: 480,
        nonBlackPixelCount: 12,
        sessionId: "try-on-session-001",
      },
      silhouetteEvidence: {
        ok: true,
        httpStatus: 200,
        contentType: "image/png",
        finalUrl:
          "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
      },
      expectedResults: baseExpectedResults(),
      installedBinding: { frameSourceBinding: frameSourceBinding() },
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnSilhouettePublicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        seededTryOnVariants: [
          {
            productId: "L",
            variantId: "variant-l",
            silhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
            silhouettePublicUrl:
              "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
          },
        ],
      },
    });
    assert.equal(summary.sessionId, "try-on-session-001");
    assert.equal(summary.nonBlackPixelCount, 12);
    assert.equal(summary.sourceFrame, null);
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            route: "#/products/product:L/try-on?variantId=variant-l",
            previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
            silhouetteUrl:
              "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
            silhouetteLoaded: true,
            silhouetteNaturalWidth: 640,
            silhouetteNaturalHeight: 1280,
          },
          mjpegEvidence: {
            contentType: "multipart/x-mixed-replace; boundary=frame",
            frameByteLength: 512,
            width: 640,
            height: 480,
            nonBlackPixelCount: 0,
            sessionId: "try-on-session-001",
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 10,
              decodedFrameCount: 11,
              sessionId: "try-on-session-001",
            }),
          },
          silhouetteEvidence: {
            ok: true,
            httpStatus: 200,
            contentType: "image/png",
            finalUrl:
              "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
          },
          expectedResults: baseExpectedResults(),
          installedBinding: { frameSourceBinding: frameSourceBinding() },
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
                silhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
              },
            ],
          },
        }),
      /remained fully black/,
    );
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            route: "#/products/product:L/try-on?variantId=variant-l",
            previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
            silhouetteUrl:
              "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
            silhouetteLoaded: true,
            silhouetteNaturalWidth: 640,
            silhouetteNaturalHeight: 1280,
          },
          mjpegEvidence: {
            contentType: "multipart/x-mixed-replace; boundary=frame",
            frameByteLength: 512,
            width: 640,
            height: 480,
            nonBlackPixelCount: 12,
            sessionId: "try-on-session-001",
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 10,
              decodedFrameCount: 11,
              sessionId: "try-on-session-001",
            }),
          },
          silhouetteEvidence: {
            ok: true,
            httpStatus: 200,
            contentType: "image/png",
            finalUrl:
              "http://127.0.0.1:26849/api/media-assets/DIFFERENT/content",
          },
          expectedResults: baseExpectedResults(),
          installedBinding: { frameSourceBinding: frameSourceBinding() },
          runtimeExpectation: {
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
                silhouettePublicUrl:
                  "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
              },
            ],
          },
        }),
      /redirect finalUrl drifted/,
    );
  });

  it("accepts preview-only try-on when silhouette is intentionally missing", () => {
    const summary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: "product:L",
        variantId: "variant-l",
      },
      tryOnState: {
        route: "#/products/product:L/try-on?variantId=variant-l",
        previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
        silhouetteUrl: null,
        silhouetteLoaded: false,
        silhouetteNaturalWidth: 0,
        silhouetteNaturalHeight: 0,
      },
      mjpegEvidence: {
        contentType: "multipart/x-mixed-replace; boundary=frame",
        frameByteLength: 2048,
        width: 640,
        height: 480,
        nonBlackPixelCount: 12,
        sessionId: "try-on-session-001",
        sourceFrame: sourceFrame("front", "c".repeat(64), {
          frameIndex: 15,
          decodedFrameCount: 16,
          sessionId: "try-on-session-001",
        }),
      },
      expectedResults: baseExpectedResults(),
      installedBinding: { frameSourceBinding: frameSourceBinding() },
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        seededTryOnVariants: [
          {
            productId: "L",
            variantId: "variant-l",
          },
        ],
      },
    });
    assert.equal(summary.sessionId, "try-on-session-001");
  });

  it("rejects preview-only try-on when the selected variant configures a silhouette", () => {
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            route: "#/products/product:L/try-on?variantId=variant-l",
            previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
            silhouetteUrl: null,
            silhouetteLoaded: false,
            silhouetteNaturalWidth: 0,
            silhouetteNaturalHeight: 0,
          },
          mjpegEvidence: {
            contentType: "multipart/x-mixed-replace; boundary=frame",
            frameByteLength: 2048,
            width: 640,
            height: 480,
            nonBlackPixelCount: 12,
            sessionId: "try-on-session-001",
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 15,
              decodedFrameCount: 16,
              sessionId: "try-on-session-001",
            }),
          },
          expectedResults: baseExpectedResults(),
          installedBinding: { frameSourceBinding: frameSourceBinding() },
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
                silhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
              },
            ],
          },
        }),
      /configured for the selected variant was not rendered/,
    );
  });

  it("requires the 7892 listener to bind the fixed installed executable and commit", () => {
    const binding = validateVisionInstalledBinding({
      installedRecord: {
        schemaVersion: "vem-vision-installed/v1",
        commit: "a".repeat(40),
        appDirectory: "C:\\VEM\\vision\\app",
        runtime: "vending-vision.exe",
        executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
        executableSha256: "b".repeat(64),
        runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
        siteConfiguration: {
          path: "C:\\ProgramData\\VEM\\vision\\site.json",
          sha256: "a".repeat(64),
        },
        launcher: {
          path: "C:\\VEM\\bringup\\start_vision.bat",
          command: "C:\\Windows\\System32\\cmd.exe",
          arguments: '/c ""C:\\VEM\\bringup\\start_vision.bat""',
          workingDirectory: "C:\\VEM\\vision\\app",
        },
        startTask: {
          path: "\\VEM\\",
          name: "StartVisionServer",
          user: "VEMKiosk",
        },
        downloadManifest: {
          path: "C:\\cache\\vision\\vending-vision-main-artifacts.json",
          sha256: "c".repeat(64),
          runtimeArchive: {
            path: "C:\\cache\\vision\\runtime.zip",
            sha256: "d".repeat(64),
          },
          fixtureArchive: {
            path: "C:\\cache\\vision\\fixtures.zip",
            sha256: "e".repeat(64),
          },
        },
        fixtureSet: {
          manifestPath:
            "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\fixture-manifest.json",
          manifestSha256: "f".repeat(64),
          top: frameSourceBinding().top,
          front: frameSourceBinding().front,
          expectedResults: frameSourceBinding().expectedResults,
        },
      },
      siteConfiguration: {
        cameras: {
          top: {
            source: "recorded_video",
            role: "presence",
            video_path: frameSourceBinding().top.path,
          },
          front: {
            source: "recorded_video",
            role: "profile_tryon",
            video_path: frameSourceBinding().front.path,
          },
        },
      },
      executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
      executableSha256: "b".repeat(64),
      siteConfigurationSha256: "a".repeat(64),
      downloadManifestSha256: "c".repeat(64),
      fixtureManifestSha256: "f".repeat(64),
      fixtureTopSha256: frameSourceBinding().top.sha256,
      fixtureFrontSha256: frameSourceBinding().front.sha256,
      fixtureExpectedResultsSha256: frameSourceBinding().expectedResults.sha256,
      processId: 4242,
      processOwner: "VEMKiosk",
      commandLine:
        '"C:\\VEM\\vision\\app\\vending-vision.exe" --config "C:\\ProgramData\\VEM\\vision\\site.json"',
      taskUser: "DOM\\VEMKiosk",
      taskCommand: "C:\\Windows\\System32\\cmd.exe",
      taskArguments: '/c ""C:\\VEM\\bringup\\start_vision.bat""',
      taskWorkingDirectory: "C:\\VEM\\vision\\app",
      listenerProcessId: 4242,
      listenerOwnerCount: 1,
      listenerBindingSource: "Get-NetTCPConnection",
    });
    assert.equal(binding.processId, 4242);
    assert.equal(binding.processOwner, "VEMKiosk");
    assert.equal(binding.frameSourceBinding.front.sha256, "c".repeat(64));
    assert.throws(
      () =>
        validateVisionInstalledBinding({
          installedRecord: {
            schemaVersion: "vem-vision-installed/v1",
            commit: "a".repeat(40),
            appDirectory: "C:\\VEM\\vision\\app",
            runtime: "vending-vision.exe",
            executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
            executableSha256: "b".repeat(64),
            runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
            siteConfiguration: {
              path: "C:\\ProgramData\\VEM\\vision\\site.json",
              sha256: "a".repeat(64),
            },
            downloadManifest: {
              path: "C:\\cache\\vision\\vending-vision-main-artifacts.json",
              sha256: "c".repeat(64),
              runtimeArchive: {
                path: "C:\\cache\\vision\\runtime.zip",
                sha256: "d".repeat(64),
              },
              fixtureArchive: {
                path: "C:\\cache\\vision\\fixtures.zip",
                sha256: "e".repeat(64),
              },
            },
            fixtureSet: {
              manifestPath:
                "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\fixture-manifest.json",
              manifestSha256: "f".repeat(64),
              top: frameSourceBinding().top,
              front: frameSourceBinding().front,
              expectedResults: frameSourceBinding().expectedResults,
            },
          },
          siteConfiguration: {
            cameras: {
              top: {
                source: "recorded_video",
                role: "presence",
                video_path: frameSourceBinding().top.path,
              },
              front: {
                source: "recorded_video",
                role: "profile_tryon",
                video_path: frameSourceBinding().front.path,
              },
            },
          },
          executablePath: "C:\\Temp\\other.exe",
          executableSha256: "b".repeat(64),
          siteConfigurationSha256: "a".repeat(64),
          downloadManifestSha256: "c".repeat(64),
          fixtureManifestSha256: "f".repeat(64),
          fixtureTopSha256: frameSourceBinding().top.sha256,
          fixtureFrontSha256: frameSourceBinding().front.sha256,
          fixtureExpectedResultsSha256:
            frameSourceBinding().expectedResults.sha256,
          processId: 1,
          processOwner: "OtherUser",
          commandLine:
            '"C:\\Temp\\other.exe" --config "C:\\ProgramData\\VEM\\vision\\site.json"',
          taskUser: "VEMKiosk",
          taskCommand: "C:\\Windows\\System32\\cmd.exe",
          taskArguments: '/c ""C:\\VEM\\bringup\\start_vision.bat""',
          taskWorkingDirectory: "C:\\VEM\\vision\\app",
          listenerProcessId: 2,
          listenerOwnerCount: 2,
          listenerBindingSource: "Get-NetTCPConnection",
        }),
      /Vision scheduled task user drifted|fixed installed executable|exactly one installed process/,
    );
  });

  it("fails closed while the target port is still occupied", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await assert.rejects(
      waitForVisionPortRelease(200, { port, host: "127.0.0.1" }),
      /Vision port release did not become true|did not become true/,
    );
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await waitForVisionPortRelease(2_000, { port, host: "127.0.0.1" });
  });

  it("stops the mock child and preserves the primary failure when cleanup also fails", async () => {
    const probeServer = createServer();
    await new Promise((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
    const { port } = probeServer.address();
    await new Promise((resolve, reject) =>
      probeServer.close((error) => (error ? reject(error) : resolve())),
    );

    const child = spawn(process.execPath, [
      "-e",
      `const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(${port}, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);`,
    ]);
    await waitForVisionPortRelease(2_000, { port, host: "127.0.0.1" }).catch(
      () => undefined,
    );
    await stopVisionChild(child, { port, host: "127.0.0.1", timeoutMs: 5_000 });

    const primary = new Error("business failed");
    const cleanup = new Error("cleanup failed");
    const combined = combineCleanupFailure(primary, cleanup);
    assert.equal(combined.errors[0], primary);
    assert.equal(combined.errors[1], cleanup);
    assert.match(combined.message, /business failed/);
    assert.match(combined.message, /cleanup failed/);
  });

  it("shuts down a failed mock child when 7892 is already occupied", async () => {
    const occupier = spawn(process.execPath, [
      "-e",
      `const http = require("node:http");
const server = http.createServer((_req, res) => {
  if (_req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", mockScenario: "success" }));
    return;
  }
  res.end("ok");
});
server.listen(7892, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);`,
    ]);
    try {
      await assert.rejects(
        startVisionMockScenario("try_on_unavailable_start", 1_000),
        /vision mock scenario try_on_unavailable_start did not become true/,
      );
    } finally {
      await stopVisionChild(occupier, {
        port: 7892,
        host: "127.0.0.1",
        timeoutMs: 5_000,
      });
    }
    await waitForVisionPortRelease(2_000, { port: 7892, host: "127.0.0.1" });
  });
});
