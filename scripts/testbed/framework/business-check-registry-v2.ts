import type { AcceptanceReport, SetValidator } from "./acceptance-report.ts";

import { validateReportWithValidators } from "./acceptance-report.ts";

export interface BusinessCheckSet {
  name: string;
  runner: { kind: "node" | "powershell"; script: string };
  validator: SetValidator;
  fullRequired?: boolean;
  core?: boolean;
}

/**
 * 业务集注册表 v2：runner 与 validator 的唯一注册入口。
 */
export function createBusinessCheckRegistryV2(sets: BusinessCheckSet[]) {
  if (!Array.isArray(sets) || sets.length === 0) {
    throw new TypeError("sets must be a non-empty array");
  }
  const byName = new Map<string, BusinessCheckSet>();
  for (const set of sets) {
    if (!set || typeof set.name !== "string" || set.name.length === 0) {
      throw new TypeError("business set name is required");
    }
    if (byName.has(set.name)) {
      throw new TypeError(`duplicate business set ${set.name}`);
    }
    if (
      !set.runner ||
      !["node", "powershell"].includes(set.runner.kind) ||
      typeof set.runner.script !== "string"
    ) {
      throw new TypeError(`business set ${set.name} runner is invalid`);
    }
    if (typeof set.validator !== "function") {
      throw new TypeError(`business set ${set.name} validator is required`);
    }
    byName.set(set.name, Object.freeze({ ...set }) as BusinessCheckSet);
  }
  const frozen = Object.freeze([...byName.values()]);
  return {
    sets: frozen,
    select({ mode, focus = [] }: { mode: string; focus?: string[] }) {
      const wanted = new Set(focus);
      if (mode === "full") {
        return frozen.filter((set) => set.fullRequired !== false);
      }
      if (wanted.size > 0) {
        return frozen.filter((set) => wanted.has(set.name));
      }
      return frozen.filter((set) => set.core === true);
    },
    validateReport(report: AcceptanceReport) {
      const validators = Object.fromEntries(
        frozen.map((set) => [set.name, set.validator]),
      );
      return validateReportWithValidators(report, validators);
    },
  };
}

/**
 * 支持证据管道：附加截图/日志等证据，不参与业务判定。
 */
export function collectSupportingEvidence(
  set: {
    name: string;
    status: "passed" | "failed" | "skipped";
    supportingEvidence?: unknown[];
  },
  sources: unknown[],
) {
  if (!Array.isArray(sources)) {
    throw new TypeError("sources must be an array");
  }
  return {
    ...set,
    supportingEvidence: [...(set.supportingEvidence ?? []), ...sources],
  };
}
