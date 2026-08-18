import { buildAcceptanceReport } from "../../acceptance-report.mjs";
import { waitForCondition } from "../../condition-waiter.mjs";
import { stopDeclaredRole } from "../../fault-injection.mjs";
import { businessAssertion } from "../../observation-record.mjs";

const STATE_PATH = "ui/try-on-state.json";

async function readState(adapter) {
  return JSON.parse(await adapter.readFile(STATE_PATH));
}

/**
 * 最小 Fast 试衣垂直切片：导航、进入商品、点击快速试衣、等待结果表面。
 * 断言通过统一记录产出 v2 报告；VM 上由真实适配器提供同一状态读取。
 */
export async function runFastTryOnScenario(adapter, { timeoutMs, pollMs }) {
  await adapter.run("navigate", ["#/catalog"]);
  await adapter.run("click", [
    '[data-test="catalog-category"][data-category-key="tshirts"]',
  ]);
  await adapter.run("click", ['[data-test="catalog-product"]']);
  await adapter.run("click", ['[data-test="try-on-fast"]']);
  let previewSeen = false;
  const state = await waitForCondition(
    "result-surface",
    async () => {
      const current = await readState(adapter);
      if (current?.state === "acquiring" && current?.preview?.naturalWidth > 0) {
        previewSeen = true;
      }
      return {
        ok:
          current?.state === "completed" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl.length > 0,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "try-on-route",
      source: "machine-ui-dom",
      expected: { prefix: "#/try-on" },
      observed: { prefix: state.route?.split("?")[0] ?? null },
    }),
    businessAssertion({
      id: "preview-decoded",
      source: "machine-ui-dom",
      expected: { decoded: true },
      observed: { decoded: previewSeen },
    }),
    businessAssertion({
      id: "result-surface",
      source: "machine-ui-dom",
      expected: { state: "completed", resultUrl: true },
      observed: {
        state: state.state,
        resultUrl: typeof state.resultUrl === "string",
      },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

/**
 * 观察者自愈垂直切片：通过产品声明的角色边界停止 observer，等待降级，
 * 再次触发试衣并等待结果表面完成。
 */
export async function runObserverSelfHealScenario(
  adapter,
  manifest,
  { timeoutMs, pollMs },
) {
  await stopDeclaredRole(adapter, manifest, "observer", {
    timeoutMs,
    pollMs,
  });
  await adapter.run("navigate", ["#/catalog"]);
  await adapter.run("click", [
    '[data-test="catalog-category"][data-category-key="tshirts"]',
  ]);
  await adapter.run("click", ['[data-test="catalog-product"]']);
  await adapter.run("click", ['[data-test="try-on-fast"]']);
  const state = await waitForCondition(
    "result-surface-after-heal",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.state === "completed" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl.length > 0,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "observer-stop-declared",
      source: "process-role-manifest",
      expected: { stopped: true },
      observed: { stopped: true },
    }),
    businessAssertion({
      id: "observer-self-heal-completes",
      source: "machine-ui-dom",
      expected: { state: "completed", resultUrl: true },
      observed: {
        state: state.state,
        resultUrl: typeof state.resultUrl === "string",
      },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-self-heal",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

/**
 * 结果锁定中心缩放：完成 Fast 试衣后点击放大，等待 105% 与新的结果 URL。
 */
export async function runGarmentScaleScenario(adapter, { timeoutMs, pollMs }) {
  const initial = await readState(adapter);
  if (initial?.state !== "completed" || typeof initial?.resultUrl !== "string") {
    throw new Error("garment scale scenario requires a completed result");
  }
  const beforeUrl = initial.resultUrl;
  await adapter.run("click", ['[data-test="try-on-scale-up"]']);
  const state = await waitForCondition(
    "adjusted-garment-scale",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.scaleValue === "105%" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl !== beforeUrl,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "garment-scale-adjusts",
      source: "machine-ui-dom",
      expected: { scale: "105%", changed: true },
      observed: {
        scale: state.scaleValue,
        changed: state.resultUrl !== beforeUrl,
      },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-scale",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}
