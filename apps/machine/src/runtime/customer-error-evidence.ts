import { recordCustomerErrorEvidence as persistCustomerErrorEvidence } from "@/local/command-log";

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
  checkoutAttemptIdempotencyKey: string | null;
  orderId: string | null;
  paymentId: string | null;
  orderNo: string | null;
}): void {
  installedTrace?.record({ type: "customer_error", ...input });
  persistCustomerErrorEvidence(input);
}
