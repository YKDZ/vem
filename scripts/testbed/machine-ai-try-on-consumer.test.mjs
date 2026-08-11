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
        "--reporter=agent",
        "--silent=passed-only",
      ],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, NODE_OPTIONS: "--conditions=vem-source" },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /Test Files\s+7 passed \(7\)/);
    assert.match(output, /Tests\s+\d+ passed \(\d+\)/);
    assert.doesNotMatch(output, /\bskipped\b|\btodo\b/i);
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
