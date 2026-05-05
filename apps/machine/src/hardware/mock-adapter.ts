import type { DispenseCommandPayload, HardwareErrorCode } from "@vem/shared";

import type {
  HardwareAdapter,
  HardwareDispenseResult,
  MockDispenseMode,
} from "./adapter";

const MOCK_MODE_KEY = "vem.machine.mockDispenseMode";

const modeToFailure: Record<
  Exclude<MockDispenseMode, "success">,
  {
    errorCode: HardwareErrorCode;
    message: string;
  }
> = {
  no_drop: { errorCode: "NO_DROP", message: "mock: item did not drop" },
  jammed: { errorCode: "JAMMED", message: "mock: slot jammed" },
  timeout: { errorCode: "MOTOR_TIMEOUT", message: "mock: motor timeout" },
};

export function getMockDispenseMode(
  storage = globalThis.localStorage,
): MockDispenseMode {
  const value = storage?.getItem(MOCK_MODE_KEY);
  if (value === "no_drop" || value === "jammed" || value === "timeout") {
    return value;
  }
  return "success";
}

export function setMockDispenseMode(
  mode: MockDispenseMode,
  storage = globalThis.localStorage,
): void {
  storage?.setItem(MOCK_MODE_KEY, mode);
}

export function createMockHardwareAdapter(
  storage = globalThis.localStorage,
): HardwareAdapter {
  return {
    async dispense(
      command: DispenseCommandPayload,
    ): Promise<HardwareDispenseResult> {
      const startedAt = new Date().toISOString();
      const mode = getMockDispenseMode(storage);
      if (mode === "timeout") {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      const finishedAt = new Date().toISOString();

      if (mode === "success") {
        return {
          commandNo: command.commandNo,
          success: true,
          errorCode: null,
          message: "mock: dispense succeeded",
          reportedAt: finishedAt,
          rawResponse: { mode, slot: command.slot },
          startedAt,
          finishedAt,
        };
      }

      const failure = modeToFailure[mode];
      return {
        commandNo: command.commandNo,
        success: false,
        errorCode: failure.errorCode,
        message: failure.message,
        reportedAt: finishedAt,
        rawResponse: { mode, slot: command.slot },
        startedAt,
        finishedAt,
      };
    },
  };
}
