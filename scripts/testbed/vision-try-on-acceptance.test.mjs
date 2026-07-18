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
  parseVisionTryOnAcceptanceArgs,
  stopVisionChild,
  validateRecommendationProjection,
  validateTryOnPresentation,
  validateVisionInstalledBinding,
  validateVisionProtocolEvidence,
  waitForVisionPortRelease,
} from "./vision-try-on-acceptance.mjs";

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
        tryOnSilhouetteAssetId:
          "550e8400-e29b-41d4-a716-446655440125",
        tryOnSilhouettePublicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        seededTryOnVariants: [
          {
            sourceRow: 31,
            productId: "product-seeded",
            variantId: "variant-seeded",
            sku: "TSC-LOCAL-031",
            size: "M",
            silhouetteAssetId:
              "550e8400-e29b-41d4-a716-446655440125",
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

  it("compares observed protocol evidence by source and fresh runtime chronology", () => {
    const summary = compareObservedVisionProtocolToExpected({
      expectedResults: baseExpectedResults(),
      protocolEvidence: {
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
          },
        },
        profile: {
          type: "vision.profile_result",
          payload: {
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
            profile: { personPresent: true },
            quality: { profileUsable: true },
          },
        },
        departure: {
          type: "vision.person_departed",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
          },
        },
      },
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
            observation: {
              startedAt: "2026-07-18T00:00:00.500Z",
              completedAt: "2026-07-18T00:00:04.000Z",
            },
            presence: {
              type: "vision.presence_status",
              payload: {
                source: "front",
                detectedAt: "2026-07-18T00:00:01.000Z",
                personPresent: true,
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2026-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2026-07-18T00:00:03.000Z",
              },
            },
          },
        }),
      /presence does not match expected-results/,
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
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2025-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2025-07-18T00:00:03.000Z",
              },
            },
          },
        }),
      /does not look fresh/,
    );
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
          { variantId: "variant-l" },
          { variantId: "variant-m" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-l");
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
            seededTryOnVariants: [{ variantId: "variant-l" }],
          },
        }),
      /runtime identity set/,
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
  });

  it("requires try-on evidence to bind the seeded variant/media asset and reject black frames", () => {
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
      },
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnSilhouettePublicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        seededTryOnVariants: [{ variantId: "variant-l" }],
      },
    });
    assert.equal(summary.sessionId, "try-on-session-001");
    assert.equal(summary.nonBlackPixelCount, 12);
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            route: "#/products/product:L/try-on?variantId=variant-l",
            previewUrl:
              "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
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
          },
          silhouetteEvidence: {
            ok: true,
            httpStatus: 200,
            contentType: "image/png",
          },
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            tryOnSilhouetteAssetId:
              "550e8400-e29b-41d4-a716-446655440125",
          },
        }),
      /remained fully black/,
    );
  });

  it("requires the 7892 listener to bind the fixed installed executable and commit", () => {
    const binding = validateVisionInstalledBinding({
      installedRecord: {
        schemaVersion: "vem-vision-installed/v1",
        commit: "a".repeat(40),
        appDirectory: "C:\\VEM\\vision\\app",
        runtime: "vending-vision.exe",
        runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
      },
      executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
      executableSha256: "b".repeat(64),
      processId: 4242,
      listenerProcessId: 4242,
      listenerOwnerCount: 1,
    });
    assert.equal(binding.processId, 4242);
    assert.throws(
      () =>
        validateVisionInstalledBinding({
          installedRecord: {
            schemaVersion: "vem-vision-installed/v1",
            commit: "a".repeat(40),
            appDirectory: "C:\\VEM\\vision\\app",
            runtime: "vending-vision.exe",
            runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
          },
          executablePath: "C:\\Temp\\other.exe",
          executableSha256: "b".repeat(64),
          processId: 1,
          listenerProcessId: 2,
          listenerOwnerCount: 2,
        }),
      /fixed installed executable|exactly one installed process/,
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
    await new Promise((resolve) =>
      probeServer.listen(0, "127.0.0.1", resolve),
    );
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
});
