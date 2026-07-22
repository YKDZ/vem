import type { MachineRuntimeTrace } from "./machine-runtime-trace";

let installedTrace: MachineRuntimeTrace | null = null;

export function installCustomerErrorEvidenceTrace(
  trace: MachineRuntimeTrace | null,
): void {
  installedTrace = trace;
}

export function recordCustomerErrorEvidence(input: {
  stage: string;
  customerMessage: string;
  technicalMessage: string;
  operation: string;
  orderNo: string | null;
}): void {
  installedTrace?.record({ type: "customer_error", ...input });
}
