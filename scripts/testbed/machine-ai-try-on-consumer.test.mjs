import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const MACHINE_STAGE5_SPECS = Object.freeze([
  "src/views/ProductDetailView.try-on.spec.ts",
  "src/views/TryOnView.spec.ts",
  "src/native/vision.spec.ts",
  "src/stores/try-on.spec.ts",
  "src/stores/vision.spec.ts",
  "src/try-on/eligibility.spec.ts",
  "src/views/ai-degradation-sale-flow.spec.ts",
]);
const REQUIRED_AI_DEGRADATION_TESTS = Object.freeze([
  "AI degradation public sale flow continues the ordinary sale through payment and dispense after a public AI failure without starting Fast",
  "AI degradation public sale flow hides only AI after a public missing-pack ready frame while Fast, buy, and catalog remain available",
]);

function assertMachineConsumerReport(report, output) {
  assert.equal(report.success, true, output);
  assert.equal(report.numFailedTests, 0, output);
  assert.equal(report.numPendingTests, 0, output);
  assert.equal(report.numTodoTests, 0, output);
  assert.equal(report.testResults.length, MACHINE_STAGE5_SPECS.length, output);
  const assertions = report.testResults.flatMap(
    (testResult) => testResult.assertionResults,
  );
  assert.ok(
    assertions.every((assertion) => assertion.status === "passed"),
    output,
  );
  assert.deepEqual(
    assertions
      .filter((assertion) =>
        assertion.fullName.startsWith("AI degradation public sale flow "),
      )
      .map((assertion) => assertion.fullName)
      .sort(),
    [...REQUIRED_AI_DEGRADATION_TESTS].sort(),
    output,
  );
}

function mutationFixture(
  assertionResults = REQUIRED_AI_DEGRADATION_TESTS.map((fullName) => ({
    fullName,
    status: "passed",
  })),
) {
  return {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      { assertionResults },
      ...Array.from({ length: MACHINE_STAGE5_SPECS.length - 1 }, () => ({
        assertionResults: [],
      })),
    ],
  };
}

describe("Machine AI try-on consumer authority", () => {
  it("runs the real Machine Vitest suites that prove independent AI mode entry and lifecycle with zero skipped tests", () => {
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "machine",
        "exec",
        "vitest",
        "run",
        ...MACHINE_STAGE5_SPECS,
        "--reporter=json",
      ],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, NODE_OPTIONS: "--conditions=vem-source" },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    const report = JSON.parse(result.stdout);
    assertMachineConsumerReport(report, output);
  });

  it("rejects missing, renamed, skipped, and failed Stage4B assertion results", () => {
    const [first, second] = REQUIRED_AI_DEGRADATION_TESTS;
    const mutations = [
      mutationFixture([{ fullName: first, status: "passed" }]),
      mutationFixture([
        { fullName: `${first} renamed`, status: "passed" },
        { fullName: second, status: "passed" },
      ]),
      mutationFixture([
        { fullName: first, status: "skipped" },
        { fullName: second, status: "passed" },
      ]),
      mutationFixture([
        { fullName: first, status: "failed" },
        { fullName: second, status: "passed" },
      ]),
    ];

    for (const mutation of mutations) {
      assert.throws(() => assertMachineConsumerReport(mutation, "mutation"));
    }
  });

  it("keeps the customer try-on path free of browser capture, a second Vision service, and automatic Fast/AI fallback", () => {
    const sources = [
      "apps/machine/src/views/ProductDetailView.vue",
      "apps/machine/src/views/TryOnView.vue",
      "apps/machine/src/native/vision.ts",
      "apps/machine/src/stores/try-on.ts",
      "apps/machine/src/try-on/eligibility.ts",
    ]
      .map((path) => readFileSync(resolve(ROOT, path), "utf-8"))
      .join("\n");

    for (const forbidden of [
      /\bnavigator[.]mediaDevices\b/,
      /\bgetUserMedia\b/,
      /\bImageCapture\b/,
      /\bHTMLCanvasElement\b/,
      /\bcreateElement\(["']canvas["']\)/,
      /\bdrawImage\b/,
      /\btoBlob\b/,
      /\btoDataURL\b/,
      /\bfetch\(/,
      /\bvision[-_]ai[-_](?:service|server|runtime)\b/i,
      /\bai[-_]vision[-_](?:service|server|runtime)\b/i,
      /mode\s*===\s*["']fast["'][\s\S]{0,160}\b(?:startAiTryOn|startAi|openVisionTryOnAttempt)\b/i,
      /mode\s*===\s*["']ai["'][\s\S]{0,160}\b(?:startFastTryOn|startFast|openVisionFastAttempt)\b/i,
      /openVisionFastAttempt[\s\S]{0,240}openVisionTryOnAttempt[\s\S]{0,120}fallback/i,
    ]) {
      assert.doesNotMatch(sources, forbidden);
    }
  });
});
