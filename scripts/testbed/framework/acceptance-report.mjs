import { summarizeAssertions } from "./observation-record.mjs";

const REPORT_SCHEMA = "vem-runtime-testbed-report/v2";
const MODES = new Set(["fast", "full"]);

export function buildAcceptanceReport({ runId, mode, pass, businessSets }) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("runId must be a non-empty string");
  }
  if (!MODES.has(mode)) {
    throw new TypeError("mode must be fast or full");
  }
  if (!Number.isInteger(pass) || pass < 1) {
    throw new TypeError("pass must be a positive integer");
  }
  if (!Array.isArray(businessSets) || businessSets.length === 0) {
    throw new TypeError("businessSets must be a non-empty array");
  }
  return {
    schemaVersion: REPORT_SCHEMA,
    runId,
    mode,
    pass,
    businessSets: businessSets.map((set) => {
      const summary = summarizeAssertions(set.assertions);
      return {
        name: set.name,
        status: summary.status,
        primaryFailure: summary.primaryFailure,
        assertionCount: summary.assertionCount,
        supportingEvidence: Array.isArray(set.supportingEvidence)
          ? set.supportingEvidence
          : [],
      };
    }),
  };
}

export function validateAcceptanceReport(report) {
  if (!report || report.schemaVersion !== REPORT_SCHEMA) {
    throw new TypeError("report schema version is invalid");
  }
  if (typeof report.runId !== "string" || report.runId.length === 0) {
    throw new TypeError("report runId is required");
  }
  if (!MODES.has(report.mode)) {
    throw new TypeError("report mode is invalid");
  }
  if (!Number.isInteger(report.pass) || report.pass < 1) {
    throw new TypeError("report pass is invalid");
  }
  if (!Array.isArray(report.businessSets) || report.businessSets.length === 0) {
    throw new TypeError("businessSets must be an array");
  }
  for (const set of report.businessSets) {
    if (typeof set?.name !== "string" || set.name.length === 0) {
      throw new TypeError("business set name is required");
    }
    if (!["passed", "failed", "skipped"].includes(set.status)) {
      throw new TypeError(`business set ${set.name} status is invalid`);
    }
    if (!Array.isArray(set.supportingEvidence)) {
      throw new TypeError(`business set ${set.name} evidence must be an array`);
    }
  }
}

/**
 * 表驱动 validator：每个业务集由注册的验证器独立判定，支持证据不参与判定。
 */
export function validateReportWithValidators(report, validators) {
  validateAcceptanceReport(report);
  const result = { businessSets: {} };
  for (const set of report.businessSets) {
    const validator = validators[set.name];
    if (!validator) {
      throw new Error(`no validator registered for business set ${set.name}`);
    }
    const verdict = validator(set);
    result.businessSets[set.name] = {
      status: verdict.ok ? "passed" : "failed",
      errors: Array.isArray(verdict.errors) ? verdict.errors : [],
    };
  }
  return result;
}
