import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IMPLICIT_RECOMMENDATION_OBSERVATION_EXPRESSION,
  IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE_EXPRESSION,
  InstalledImplicitRecommendationAdapter,
  parseImplicitRecommendationObservation,
} from "./implicit-recommendation-cdp-adapter.ts";

function observationFixture() {
  return {
    observedAtMs: Date.parse("2026-08-24T10:00:00.200Z"),
    presentation: {
      observedAtMs: Date.parse("2026-08-24T10:00:00.010Z"),
      sessionId: "presence:one",
    },
    route: "#/catalog",
    banner: { visible: true, state: "active", text: "智能选码已开启" },
    catalog: {
      visible: true,
      categoryKey: "tshirts",
      sessionId: "presence:one",
      canonicalSize: "L",
      profileEventId: "profile:one",
      cards: [
        {
          catalogKey: "product:550e8400-e29b-41d4-a716-446655440120",
          preferredVariantId: "550e8400-e29b-41d4-a716-446655440121",
          smartSizingSupported: true,
          smartSizingText: "支持智能选码 · 进入查看",
        },
      ],
    },
    detail: null,
    trace: [
      {
        id: 41,
        event: "neutral_presented",
        sessionId: "presence:one",
        canonicalSize: "M",
        profileEventId: null,
        recordedAt: "2026-08-24T10:00:00.000Z",
      },
      {
        id: 42,
        event: "refined_once",
        sessionId: "presence:one",
        canonicalSize: "L",
        profileEventId: "profile:one",
        recordedAt: "2026-08-24T10:00:00.100Z",
      },
    ],
  };
}

describe("installed implicit recommendation CDP adapter", () => {
  it("maps only the public fixture, navigation, DOM and screenshot boundaries", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const evaluations: string[] = [];
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    const boundary = {
      client: { send: async () => ({}) },
      async run(command: string, args: string[] = []) {
        commands.push({ command, args });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const adapter = new InstalledImplicitRecommendationAdapter({
      boundary,
      artifactRoot: "C:\\evidence\\implicit-recommendation-artifacts",
      evaluateImpl: async (_client, expression) => {
        evaluations.push(expression);
        return expression ===
          IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE_EXPRESSION
          ? true
          : observationFixture();
      },
      captureImpl: async (_client, options) => {
        const bytes = Buffer.from("png");
        const ref = await options.screenshotSink?.({
          bytes,
          sha256: "a".repeat(64),
          format: "png",
          label: options.label ?? "screenshot",
        });
        return {
          sha256: "a".repeat(64),
          byteLength: bytes.length,
          format: "png",
          ref: typeof ref === "string" ? ref : (ref?.ref ?? null),
        };
      },
      io: {
        mkdir: async () => undefined,
        writeFile: async (path, bytes) => {
          writes.push({ path: String(path), bytes: Buffer.from(bytes) });
        },
      },
    });

    await adapter.restoreDefaultFixtures();
    await adapter.selectFieldFixtures("near");
    await adapter.navigateCatalogHome();
    await adapter.openTshirtCategory();
    await adapter.openSmartSizedProduct(
      "product:550e8400-e29b-41d4-a716-446655440120",
    );
    assert.equal((await adapter.observe()).catalog.canonicalSize, "L");
    assert.equal(
      await adapter.captureScreenshot("implicit-recommendation-near-catalog"),
      "C:\\evidence\\implicit-recommendation-artifacts/implicit-recommendation-near-catalog.png",
    );

    assert.deepEqual(commands, [
      { command: "restore-recorded-video-fixtures", args: [] },
      { command: "select-recommendation-video-fixture", args: ["near"] },
      { command: "navigate", args: ["#/catalog"] },
      {
        command: "click",
        args: ['[data-test="catalog-category"][data-category-key="tshirts"]'],
      },
      {
        command: "click",
        args: [
          '[data-test="catalog-product"][data-catalog-key="product:550e8400-e29b-41d4-a716-446655440120"]',
        ],
      },
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.bytes.toString(), "png");
    assert.deepEqual(evaluations, [
      IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE_EXPRESSION,
      IMPLICIT_RECOMMENDATION_OBSERVATION_EXPRESSION,
    ]);
  });

  it("fails closed on malformed runtime trace facts", () => {
    const invalid = observationFixture();
    invalid.trace[0]!.recordedAt = "not-a-time";
    assert.throws(
      () => parseImplicitRecommendationObservation(invalid),
      /runtime trace entry/,
    );
    assert.throws(
      () =>
        parseImplicitRecommendationObservation({
          ...observationFixture(),
          observedAtMs: Number.NaN,
        }),
      /observation timestamp/,
    );
    assert.throws(
      () =>
        parseImplicitRecommendationObservation({
          ...observationFixture(),
          presentation: { observedAtMs: null, sessionId: "presence:one" },
        }),
      /presentation timing is incomplete/,
    );
  });
});
