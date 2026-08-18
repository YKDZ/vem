import { buildAcceptanceReport } from "../../acceptance-report.mjs";
import {
  runFastTryOnScenario,
  runGarmentScaleScenario,
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
  timeoutMs = 60_000,
  pollMs = 250,
}) {
  const fast = await runFastTryOnScenario(adapter, { timeoutMs, pollMs });
  const assertions = [...fast.assertions];
  if (includeGarmentScale) {
    const scale = await runGarmentScaleScenario(adapter, { timeoutMs, pollMs });
    assertions.push(...scale.assertions);
  }
  if (includeSelfHeal && manifest) {
    const heal = await runObserverSelfHealScenario(adapter, manifest, {
      timeoutMs,
      pollMs,
    });
    assertions.push(...heal.assertions);
  }
  return buildAcceptanceReport({
    runId: "slice-vision-experience",
    mode: "fast",
    pass: 1,
    businessSets: [{ name: "visionExperience", assertions }],
  });
}
