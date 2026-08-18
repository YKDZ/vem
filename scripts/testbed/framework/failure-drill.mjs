import { buildAcceptanceReport } from "./acceptance-report.mjs";
import { businessAssertion, observationStream } from "./observation-record.mjs";

/**
 * 受控故障演练：构造一个必然失败的断言并证明失败根因可从上卷产物中恢复。
 * 作为验收步骤的一部分，确保观测上卷不是口头承诺。
 */
export async function runFailureDrill() {
  const failing = businessAssertion({
    id: "drill-result-surface",
    source: "machine-ui-dom",
    expected: { state: "completed" },
    observed: { state: "acquiring" },
  });
  const stream = observationStream();
  stream.append({
    type: "business_assertion",
    track: "drill",
    record: failing,
  });
  const report = buildAcceptanceReport({
    runId: "drill",
    mode: "fast",
    pass: 1,
    businessSets: [{ name: "drill", assertions: [failing] }],
  });
  return {
    status: report.businessSets[0].status,
    primaryFailure: report.businessSets[0].primaryFailure,
    serializedLine: stream.lines()[0],
  };
}
