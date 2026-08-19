import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { ProcessRoleManifest } from "../../fault-injection.ts";
import type { BusinessSetReport } from "../../observation-record.ts";
import type { TestAdapter } from "../../test-adapter.ts";

import { buildAcceptanceReport } from "../../acceptance-report.ts";
import { CdpTestAdapter } from "../../cdp-adapter.ts";
import { waitForCondition } from "../../condition-waiter.ts";
import { createProcessRoleManifest } from "../../fault-injection.ts";
import {
  runFastTryOnScenario,
  runDegradationScenario,
  runDepartureScenario,
  runGarmentScaleScenario,
  runManualCaptureScenario,
  runObserverSelfHealScenario,
} from "./vision-experience-driver.ts";

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
  visionStabilityMs = 10_000,
  visionStabilityTimeoutMs = 60_000,
}: {
  adapter: TestAdapter;
  manifest?: ProcessRoleManifest | null;
  includeSelfHeal?: boolean;
  includeGarmentScale?: boolean;
  includeDegradation?: boolean;
  includeManualCapture?: boolean;
  includeDeparture?: boolean;
  stopOwner?: (() => void) | null;
  timeoutMs?: number;
  pollMs?: number;
  visionStabilityMs?: number;
  visionStabilityTimeoutMs?: number;
}) {
  await waitForCondition(
    "vision-ready",
    async () => {
      try {
        const probe = await adapter.run("vision-ready");
        return { ok: probe?.exitCode === 0, value: probe?.stdout ?? null };
      } catch {
        return { ok: false, value: null };
      }
    },
    { timeoutMs: Math.max(timeoutMs, 300_000), pollMs: 1_000 },
  );
  await waitForVisionStable(adapter, {
    timeoutMs: visionStabilityTimeoutMs,
    stabilityMs: visionStabilityMs,
    pollMs: 1_000,
  });
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

/**
 * 启动期竞态守卫：Vision 角色可能刚 ready 又立刻重启（owner 拉起/旧进程退出）。
 * 只有角色 PID 集合在 stabilityMs 窗口内保持不变，才认为 Vision 已经稳定，
 * 避免 attempt 发给正在重启的进程。这是有界条件等待，不是重试循环。
 */
export async function waitForVisionStable(
  adapter: TestAdapter,
  {
    timeoutMs = 60_000,
    stabilityMs = 10_000,
    pollMs = 1_000,
  }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number },
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastSignature: string | null = null;
  let stableSince: number | null = null;
  let lastObservation: { signature: string; exitCode: number } | null = null;
  while (Date.now() < deadline) {
    const probe = await adapter.run("vision-ready");
    let signature: string;
    try {
      const parsed = JSON.parse(probe.stdout ?? "");
      signature = JSON.stringify(parsed?.pids ?? null);
    } catch {
      // 非 JSON 的 fake 适配器不提供 PID 数据，ready 已由 vision-ready 门保证。
      return probe.stdout ?? "";
    }
    lastObservation = { signature, exitCode: probe.exitCode };
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - (stableSince ?? 0) >= stabilityMs) {
      return signature;
    }
    await new Promise((resolvePromise) =>
      setTimeout(
        resolvePromise,
        Math.min(pollMs, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  const durationMs = Date.now() - startedAt;
  throw new Error(
    `vision-stable did not become true in ${timeoutMs} ms (observed ${durationMs} ms): ${JSON.stringify(lastObservation ?? null)}`,
  );
}

export function validateVisionExperienceSet(set: BusinessSetReport) {
  return {
    ok: set?.status === "passed",
    errors: set?.status === "failed" ? ["vision assertions failed"] : [],
  };
}

/**
 * VM 轨道入口：从环境读取 CDP 与 Vision 地址，运行全部业务场景并输出 v2 报告。
 */
export async function main(args: string[] = process.argv.slice(2)) {
  const outIndex = args.indexOf("--out");
  const outPath: string | null = outIndex >= 0 ? args[outIndex + 1] : null;
  // 重建后的 VM 可能尚未启动 Vision 默认 owner；轨道负责启动并等待就绪。
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Start-ScheduledTask -TaskName VEMVisionRuntime",
    ],
    { stdio: "ignore" },
  );
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
      visionStabilityMs: Number(process.env.VISION_STABILITY_MS ?? 10_000),
      visionStabilityTimeoutMs: Number(
        process.env.VISION_STABILITY_TIMEOUT_MS ?? 60_000,
      ),
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
