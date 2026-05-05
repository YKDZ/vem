import type {
  DispenseCommandPayload,
  DispenseResultPayload,
} from "@vem/shared";

export type MockDispenseMode = "success" | "no_drop" | "jammed" | "timeout";

export type HardwareDispenseResult = DispenseResultPayload & {
  rawResponse: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
};

export type HardwareAdapter = {
  dispense(command: DispenseCommandPayload): Promise<HardwareDispenseResult>;
};

export function toDispenseResultPayload(
  result: HardwareDispenseResult,
): DispenseResultPayload {
  return {
    commandNo: result.commandNo,
    success: result.success,
    errorCode: result.errorCode,
    message: result.message,
    reportedAt: result.reportedAt,
  };
}
