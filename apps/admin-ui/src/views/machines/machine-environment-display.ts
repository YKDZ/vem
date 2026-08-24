import type { MachineCommandStatus } from "@vem/shared";

import type { EnvironmentCommandSnapshot } from "./environment-command-poller";
import type { EnvironmentControlAction } from "./machine-contract-mappers";

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
  if (status === "acknowledged") return "等待设置接纳";
  if (status === "succeeded") return "设置已保存";
  if (status === "failed") return "设置未接受";
  if (status === "timeout") return "接纳结果未知";
  return "命令状态未知";
}

export function environmentCommandFailureLabel(
  resultJson: Record<string, unknown> | null | undefined,
  lastError: string | null | undefined,
): string | null {
  const reasonCode =
    typeof resultJson?.reasonCode === "string" ? resultJson.reasonCode : null;
  const resultMessage =
    typeof resultJson?.message === "string" ? resultJson.message : null;
  const sources = [reasonCode, resultMessage, lastError].filter(
    (value): value is string => Boolean(value),
  );
  if (sources.some((value) => value.includes("acceptance_unknown"))) {
    return "设置接纳结果未知，请先刷新权威状态再决定是否重试";
  }
  if (reasonCode === "action_id_conflict") {
    return "动作编号与已保存内容冲突";
  }
  if (reasonCode === "command_expired") {
    return "命令到达设备前已过期";
  }
  if (
    reasonCode === "runtime_closed" ||
    reasonCode === "environment_control_runtime_unavailable"
  ) {
    return "设备环境控制服务暂不可用";
  }
  if (reasonCode === "action_not_accepted") {
    return "设置未被设备接纳";
  }
  return resultMessage ?? lastError ?? null;
}

export function environmentControlActionLabel(
  action: EnvironmentControlAction,
): string {
  if (action === "airConditionerOn") return "空调";
  if (action === "targetTemperatureCelsius") return "目标温度";
  return "出风口与风速";
}

export function environmentControlFeedback(
  action: EnvironmentControlAction,
  command: EnvironmentCommandSnapshot,
): { type: "success" | "error"; content: string } | null {
  const actionLabel = environmentControlActionLabel(action);
  if (command.status === "succeeded") {
    const convergence = command.resultJson?.convergence;
    if (convergence === "applied") {
      return { type: "success", content: `${actionLabel}设置已保存并应用` };
    }
    if (convergence === "offline") {
      return {
        type: "success",
        content: `${actionLabel}设置已保存，下位机恢复后将自动同步`,
      };
    }
    if (convergence === "failed") {
      return {
        type: "error",
        content: `${actionLabel}设置已保存，但下位机应用失败`,
      };
    }
    return { type: "success", content: `${actionLabel}设置已保存，正在同步` };
  }
  if (command.status !== "failed" && command.status !== "timeout") return null;

  const failure =
    environmentCommandFailureLabel(command.resultJson, command.lastError) ??
    (command.status === "timeout"
      ? "设备控制超时，请稍后确认后重试"
      : "设备控制未完成，请稍后重试");
  return { type: "error", content: `${actionLabel}控制失败：${failure}` };
}
