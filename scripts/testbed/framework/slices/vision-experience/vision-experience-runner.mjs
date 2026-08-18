import { buildAcceptanceReport } from "../../acceptance-report.mjs";
import { CdpTestAdapter } from "../../cdp-adapter.mjs";
import { createProcessRoleManifest } from "../../fault-injection.mjs";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  runFastTryOnScenario,
  runDegradationScenario,
  runDepartureScenario,
  runGarmentScaleScenario,
  runManualCaptureScenario,
  runObserverSelfHealScenario,
} from "./vision-experience-driver.mjs";

/**
 * visionExperience 切片 runner：用同一 adapter 跑快速试衣与可选自愈场景，
 * 合并断言输出统一报告；fake 与真实 CDP adapter 共用。
 */
export async function runVisionExperienceSlice({
  adapter,
  manifest = null,
  includeSelfHeal = false,
  includeGarmentScale = false,
  includeDegradation = false,
  includeManualCapture = false,
  includeDeparture = false,
  stopOwner = null,
  timeoutMs = 60_000,
  pollMs = 250,
}) {
  const fast = await runFastTryOnScenario(adapter, { timeoutMs, pollMs });
  const assertions = [...fast.assertions];
  if (includeSelfHeal && manifest) {
    const heal = await runObserverSelfHealScenario(adapter, manifest, {
      timeoutMs,
      pollMs,
    });
    assertions.push(...heal.assertions);
  }
  if (includeGarmentScale) {
    const scale = await runGarmentScaleScenario(adapter, { timeoutMs, pollMs });
    assertions.push(...scale.assertions);
  }
  if (includeDegradation && stopOwner) {
    const degradation = await runDegradationScenario(adapter, {
      stopOwner,
      timeoutMs,
      pollMs,
    });
    assertions.push(...degradation.assertions);
  }
  if (includeManualCapture) {
    const manual = await runManualCaptureScenario(adapter, {
      timeoutMs,
      pollMs,
    });
    assertions.push(...manual.assertions);
  }
  if (includeDeparture) {
    const departure = await runDepartureScenario(adapter, {
      timeoutMs,
      pollMs,
    });
    assertions.push(...departure.assertions);
  }
  return buildAcceptanceReport({
    runId: "slice-vision-experience",
    mode: "fast",
    pass: 1,
    businessSets: [{ name: "visionExperience", assertions }],
  });
}

export function validateVisionExperienceSet(set) {
  return {
    ok: set?.status === "passed",
    errors: set?.status === "failed" ? ["vision assertions failed"] : [],
  };
}

/**
 * VM 轨道入口：从环境读取 CDP 与 Vision 地址，运行全部业务场景并输出 v2 报告。
 */
export async function main(args = process.argv.slice(2)) {
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const adapter = new CdpTestAdapter();
  await adapter.connect({ timeoutMs: 20_000 });
  try {
    const manifest = createProcessRoleManifest({
      roles: {
        observer: {
          stopCommand: ["stop-vision-role", "--role", "observer"],
          probeCommand: ["probe-vision-role", "observer"],
        },
      },
    });
    const report = await runVisionExperienceSlice({
      adapter,
      manifest,
      includeSelfHeal: process.env.SKIP_SELF_HEAL !== "1",
      includeGarmentScale: process.env.SKIP_SCALE !== "1",
      includeDegradation: process.env.RUN_DEGRADATION === "1",
      includeManualCapture: process.env.RUN_MANUAL === "1",
      includeDeparture: process.env.RUN_DEPARTURE === "1",
      stopOwner: () => {
        spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Stop-ScheduledTask -TaskName VEMVisionRuntime; Get-Process vending-vision -ErrorAction SilentlyContinue | Stop-Process -Force",
          ],
          { stdio: "ignore" },
        );
      },
      timeoutMs: 60_000,
      pollMs: 250,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outPath) {
      await writeFile(outPath, serialized, "utf8");
    }
    process.stdout.write(serialized);
    // 轨道结束后恢复基线：Machine UI 回到 Catalog，避免干扰后续轨道。
    await adapter.run("navigate", ["#/catalog"]).catch(() => {});
  } finally {
    await adapter.close();
  }
}

if (
  typeof import.meta !== "undefined" &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
