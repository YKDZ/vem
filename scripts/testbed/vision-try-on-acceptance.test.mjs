import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRecordedVisionSiteConfiguration,
  compareObservedVisionProtocolToExpected,
  normalizeVisionExpectedResults,
  parseVisionTryOnAcceptanceArgs,
  validateRecommendationProjection,
  validateTryOnPresentation,
  validateVisionInstalledBinding,
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

  it("requires same-commit expected results with strict source and recommendation facts", () => {
    const normalized = normalizeVisionExpectedResults({
      schemaVersion: "vending-vision-expected-results/v1",
      protocol: {
        ready: { protocol: "vem.vision.v1" },
        presence: {
          type: "vision.presence_status",
          source: "top",
          detectedAt: "2026-07-18T00:00:01.000Z",
        },
        profile: {
          type: "vision.profile_result",
          source: "front",
          detectedAt: "2026-07-18T00:00:02.000Z",
        },
        departure: {
          type: "vision.person_departed",
          source: "top",
          detectedAt: "2026-07-18T00:00:03.000Z",
        },
      },
      recommendation: {
        orderedCatalogKeys: ["product:L", "product:M"],
        selectedCatalogKey: "product:L",
        selectedVariantId: "variant-l",
        minimumScore: 0.6,
      },
      tryOn: {
        selectedCatalogKey: "product:L",
        selectedVariantId: "variant-l",
      },
    });
    assert.equal(normalized.protocol.profile.source, "front");
    assert.equal(normalized.recommendation.selectedVariantId, "variant-l");
    assert.equal(normalized.tryOn.previewPathPrefix, "http://127.0.0.1:7892/try-on/");
    assert.throws(
      () =>
        normalizeVisionExpectedResults({
          protocol: {},
          recommendation: {},
          tryOn: {},
        }),
      /presence expected result|orderedCatalogKeys/,
    );
  });

  it("compares observed protocol evidence to fixture timestamps and source order", () => {
    const expectedResults = {
      protocol: {
        ready: { protocol: "vem.vision.v1" },
        presence: {
          type: "vision.presence_status",
          source: "top",
          detectedAt: "2026-07-18T00:00:01.000Z",
        },
        profile: {
          type: "vision.profile_result",
          source: "front",
          detectedAt: "2026-07-18T00:00:02.000Z",
        },
        departure: {
          type: "vision.person_departed",
          source: "top",
          detectedAt: "2026-07-18T00:00:03.000Z",
        },
      },
      recommendation: {
        orderedCatalogKeys: ["product:L"],
        selectedCatalogKey: "product:L",
        selectedVariantId: "variant-l",
        minimumScore: 0.6,
      },
      tryOn: {
        selectedCatalogKey: "product:L",
        selectedVariantId: "variant-l",
      },
    };
    const summary = compareObservedVisionProtocolToExpected({
      expectedResults,
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
    assert.throws(
      () =>
        compareObservedVisionProtocolToExpected({
          expectedResults,
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
  });

  it("fails closed unless recommendation order, variant, score, and identity redaction all match", () => {
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
      expectedResults: {
        protocol: {
          presence: {
            type: "vision.presence_status",
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
          },
          profile: {
            type: "vision.profile_result",
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
          },
          departure: {
            type: "vision.person_departed",
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
          },
        },
        recommendation: {
          orderedCatalogKeys: ["product:L", "product:M"],
          selectedCatalogKey: "product:L",
          selectedVariantId: "variant-l",
          minimumScore: 0.5,
        },
        tryOn: {
          selectedCatalogKey: "product:L",
          selectedVariantId: "variant-l",
        },
      },
    });
    assert.equal(summary.selectedCatalogKey, "product:L");
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
          expectedResults: {
            protocol: {
              presence: {
                type: "vision.presence_status",
                source: "top",
                detectedAt: "2026-07-18T00:00:01.000Z",
              },
              profile: {
                type: "vision.profile_result",
                source: "front",
                detectedAt: "2026-07-18T00:00:02.000Z",
              },
              departure: {
                type: "vision.person_departed",
                source: "top",
                detectedAt: "2026-07-18T00:00:03.000Z",
              },
            },
            recommendation: {
              orderedCatalogKeys: ["product:M"],
              selectedCatalogKey: "product:M",
              selectedVariantId: "variant-m",
              minimumScore: 0.5,
            },
            tryOn: {
              selectedCatalogKey: "product:M",
              selectedVariantId: "variant-m",
            },
          },
        }),
      /did not actually change|leaked identity field/,
    );
  });

  it("requires try-on MJPEG evidence to bind the selected variant and decode visible pixels", () => {
    const summary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: "product:L",
        variantId: "variant-l",
      },
      tryOnState: {
        route: "#/products/product:L/try-on?variantId=variant-l",
        previewUrl: "http://127.0.0.1:7892/try-on/try-on-session-001.mjpeg",
        silhouetteUrl:
          "https://api.example.invalid/api/media-assets/try-on-silhouettes/l.png",
      },
      mjpegEvidence: {
        contentType: "multipart/x-mixed-replace; boundary=frame",
        frameByteLength: 2048,
        width: 640,
        height: 480,
        nonEmptyPixelCount: 12,
        sessionId: "try-on-session-001",
      },
      expectedResults: {
        protocol: {
          presence: {
            type: "vision.presence_status",
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
          },
          profile: {
            type: "vision.profile_result",
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
          },
          departure: {
            type: "vision.person_departed",
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
          },
        },
        recommendation: {
          orderedCatalogKeys: ["product:L"],
          selectedCatalogKey: "product:L",
          selectedVariantId: "variant-l",
          minimumScore: 0.5,
        },
        tryOn: {
          selectedCatalogKey: "product:L",
          selectedVariantId: "variant-l",
        },
      },
    });
    assert.equal(summary.sessionId, "try-on-session-001");
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
              "https://api.example.invalid/api/media-assets/try-on-silhouettes/l.png",
          },
          mjpegEvidence: {
            contentType: "multipart/x-mixed-replace; boundary=frame",
            frameByteLength: 32,
            width: 640,
            height: 480,
            nonEmptyPixelCount: 0,
            sessionId: "try-on-session-001",
          },
          expectedResults: {
            protocol: {
              presence: {
                type: "vision.presence_status",
                source: "top",
                detectedAt: "2026-07-18T00:00:01.000Z",
              },
              profile: {
                type: "vision.profile_result",
                source: "front",
                detectedAt: "2026-07-18T00:00:02.000Z",
              },
              departure: {
                type: "vision.person_departed",
                source: "top",
                detectedAt: "2026-07-18T00:00:03.000Z",
              },
            },
            recommendation: {
              orderedCatalogKeys: ["product:L"],
              selectedCatalogKey: "product:L",
              selectedVariantId: "variant-l",
              minimumScore: 0.5,
            },
            tryOn: {
              selectedCatalogKey: "product:L",
              selectedVariantId: "variant-l",
            },
          },
        }),
      /did not deliver a decodable frame|contained no visible pixels/,
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
});
