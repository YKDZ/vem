import { buildAcceptanceReport } from "../../acceptance-report.mjs";
import { waitForCondition } from "../../condition-waiter.mjs";
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
  await adapter.run("click", ["catalog-product"]);
  await adapter.run("click", ["try-on-fast"]);
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
