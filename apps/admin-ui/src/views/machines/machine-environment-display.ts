import type { MachineCommandStatus } from "@vem/shared";

export function formatEnvironmentNumber(
  value: number | undefined,
  suffix: string,
): string {
  if (typeof value !== "number") return `-- ${suffix}`;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return suffix.startsWith("%")
    ? `${formatted}${suffix}`
    : `${formatted} ${suffix}`;
}

export function sensorStatusLabel(status: string | undefined): string {
  if (status === "ok") return "传感器正常";
  if (status === "faulted") return "传感器故障";
  return "传感器未知";
}

export function airConditionerLabel(on: boolean | undefined): string {
  if (on === true) return "空调开";
  if (on === false) return "空调关";
  return "空调未知";
}

export function targetTemperatureLabel(
  value: number | null | undefined,
): string {
  if (typeof value !== "number") return "目标未知";
  return `目标 ${formatEnvironmentNumber(value, "C")}`;
}

export function commandStatusLabel(
  status: MachineCommandStatus | null,
): string {
  if (status === "pending") return "命令待发送";
  if (status === "sent") return "命令已发送";
  if (status === "acknowledged") return "命令已确认";
  if (status === "succeeded") return "命令成功";
  if (status === "failed") return "命令失败";
  if (status === "timeout") return "命令超时";
  return "命令状态未知";
}

const ventSpeedRequestedValue: Record<number, string> = {
  0: "关闭",
  1: "低",
  2: "中",
  3: "高",
  4: "全",
};

export function environmentCommandRequestedValue(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) return null;
  if (payload.airConditionerOn === true) return "开启";
  if (payload.airConditionerOn === false) return "软关闭";
  if (typeof payload.targetTemperatureCelsius === "number") {
    return `${payload.targetTemperatureCelsius} C`;
  }
  if (typeof payload.ventSpeed === "number") {
    return (
      ventSpeedRequestedValue[payload.ventSpeed] ?? String(payload.ventSpeed)
    );
  }
  return null;
}

export function environmentCommandFailureLabel(
  resultJson: Record<string, unknown> | null | undefined,
  lastError: string | null | undefined,
): string | null {
  const errorCode =
    typeof resultJson?.errorCode === "string" ? resultJson.errorCode : null;
  const resultMessage =
    typeof resultJson?.message === "string" ? resultJson.message : null;
  const sources = [errorCode, resultMessage, lastError].filter(
    (value): value is string => Boolean(value),
  );
  if (sources.some((value) => value.includes("DISPENSE_IN_PROGRESS"))) {
    return "设备正在出货，请稍后重试";
  }
  if (
    sources.some((value) => value.includes("ENVIRONMENT_COMMAND_IN_PROGRESS"))
  ) {
    return "上一项设备控制尚未完成，请稍后重试";
  }
  if (errorCode === "E1") return "控制器拒绝执行（E1）";
  if (errorCode === "E4") return "控制器操作过于频繁，请稍后重试（E4）";
  if (sources.some((value) => value.toLowerCase().includes("timeout"))) {
    return "设备控制超时，请稍后确认后重试";
  }
  if (lastError) return lastError;
  return resultMessage;
}
