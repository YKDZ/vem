import type {
  BusinessSetInput,
  BusinessSetReport,
} from "./observation-record.ts";

import { summarizeAssertions } from "./observation-record.ts";

const REPORT_SCHEMA = "vem-runtime-testbed-report/v2";
const MODES = new Set(["fast", "full"]);

export interface AcceptanceReport {
  schemaVersion: string;
  runId: string;
  mode: string;
  pass: number;
  businessSets: BusinessSetReport[];
}

export interface SetValidator {
  (set: BusinessSetReport): { ok: boolean; errors?: unknown[] };
}

export function buildAcceptanceReport({
  runId,
  mode,
  pass,
  businessSets,
}: {
  runId: string;
  mode: string;
  pass: number;
  businessSets: BusinessSetInput[];
}): AcceptanceReport {
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

export function validateAcceptanceReport(report: unknown): void {
  const value = report as AcceptanceReport;
  if (!value || value.schemaVersion !== REPORT_SCHEMA) {
    throw new TypeError("report schema version is invalid");
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    throw new TypeError("report runId is required");
  }
  if (!MODES.has(value.mode)) {
    throw new TypeError("report mode is invalid");
  }
  if (!Number.isInteger(value.pass) || value.pass < 1) {
    throw new TypeError("report pass is invalid");
  }
  if (!Array.isArray(value.businessSets) || value.businessSets.length === 0) {
    throw new TypeError("businessSets must be an array");
  }
  for (const set of value.businessSets) {
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
export function validateReportWithValidators(
  report: AcceptanceReport,
  validators: Record<string, SetValidator>,
): {
  businessSets: Record<string, { status: string; errors: unknown[] }>;
} {
  validateAcceptanceReport(report);
  const result: {
    businessSets: Record<string, { status: string; errors: unknown[] }>;
  } = { businessSets: {} };
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
