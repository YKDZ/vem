import type { ProductionPilotReadinessCheck } from "@/api/machines";

export type ProductionPilotReadinessCheckCopy = {
  code: string;
  label: string;
  statusLabel: string;
  message: string;
  operatorAction: string;
};

export function productionPilotCheckCode(
  check: ProductionPilotReadinessCheck,
): string {
  return `${check.kind}.${check.reasonCode}`;
}

export function productionPilotStatusLabel(
  status: ProductionPilotReadinessCheck["status"],
): string {
  if (status === "ready") return "通过";
  if (status === "blocked") return "阻塞";
  if (status === "degraded") return "降级";
  return "缺少证据";
}

function machineHeartbeatMessage(
  check: Extract<ProductionPilotReadinessCheck, { kind: "machine_heartbeat" }>,
): string {
  if (check.reasonCode === "online") return "机器在线，心跳仍在有效窗口内。";
  if (check.reasonCode === "stale") {
    const age = check.evidence.heartbeatAgeSeconds;
    const timeout = check.evidence.timeoutSeconds;
    return typeof age === "number"
      ? `机器心跳已超时，最近心跳距今 ${age} 秒，门限为 ${timeout} 秒。`
      : `机器心跳已超时，门限为 ${timeout} 秒。`;
  }
  return "机器未在线，或平台尚未收到可用心跳。";
}

function saleReadinessMessage(
  check: Extract<
    ProductionPilotReadinessCheck,
    { kind: "machine_sale_readiness" }
  >,
): string {
  if (check.reasonCode === "restored") return "机器运行时报告售卖就绪已恢复。";
  if (check.evidence.blockingCodes.length === 0) {
    return "机器运行时尚未报告售卖就绪恢复。";
  }
  return `机器运行时仍有售卖阻塞：${check.evidence.blockingCodes.join("、")}。`;
}

function stockAttestationMessage(
  check: Extract<
    ProductionPilotReadinessCheck,
    { kind: "physical_stock_attestation" }
  >,
): string {
  if (check.reasonCode === "ready")
    return "物理库存确认已完成，并匹配当前货盘。";
  if (check.reasonCode === "planogram_mismatch") {
    return "物理库存确认对应的货盘版本与平台当前已确认货盘不一致。";
  }
  if (check.reasonCode === "stale") {
    return "物理库存确认已过期，需要按当前货盘重新确认。";
  }
  if (check.reasonCode === "inconsistent") {
    return "物理库存确认与当前机器库存状态不一致。";
  }
  return "缺少物理库存确认。";
}

function assertNever(value: never): never {
  throw new Error(`未覆盖的生产试运营诊断项：${String(value)}`);
}

export function projectProductionPilotReadinessCheck(
  check: ProductionPilotReadinessCheck,
): ProductionPilotReadinessCheckCopy {
  const statusLabel = productionPilotStatusLabel(check.status);

  switch (check.kind) {
    case "machine_heartbeat":
      return {
        code: productionPilotCheckCode(check),
        label: "在线与心跳",
        statusLabel,
        message: machineHeartbeatMessage(check),
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "恢复机器网络连接，并等待平台收到新的机器心跳。",
      };
    case "machine_sale_readiness":
      return {
        code: productionPilotCheckCode(check),
        label: "机器售卖就绪",
        statusLabel,
        message: saleReadinessMessage(check),
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "先在机器维护界面处理售卖阻塞，再进入生产试运营。",
      };
    case "payment_readiness":
      return {
        code: productionPilotCheckCode(check),
        label: "真实支付就绪",
        statusLabel,
        message:
          check.reasonCode === "ready"
            ? `已配置 ${check.evidence.productionProviderCount} 个生产支付通道。`
            : "未配置可用于生产试运营的真实支付通道。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "为该机器启用真实支付通道后再开始生产试运营。",
      };
    case "scanner_runtime_status":
      return {
        code: productionPilotCheckCode(check),
        label: "扫码器运行状态",
        statusLabel,
        message:
          check.reasonCode === "ready"
            ? "扫码器运行状态可用。"
            : "缺少可用的扫码器运行状态证据。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "检查扫码器运行状态；若真实支付已就绪，二维码支付仍可作为可用路径。",
      };
    case "natural_context_readiness":
      return {
        code: productionPilotCheckCode(check),
        label: "自然上下文就绪",
        statusLabel,
        message:
          check.reasonCode === "ready" || check.reasonCode === "stale"
            ? "机器自然上下文可用于增强顾客体验。"
            : check.reasonCode === "unconfigured"
              ? "机器尚未配置地理坐标，无法获取外部自然环境。"
              : "外部自然环境暂不可用。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : check.actionCode === "configure_machine_geo_location"
              ? "配置机器地理坐标；这不会阻塞核心售卖就绪。"
              : "检查外部自然环境诊断；这不会阻塞核心售卖就绪。",
      };
    case "production_dispense_path":
      return {
        code: productionPilotCheckCode(check),
        label: "真实出货路径",
        statusLabel,
        message:
          check.reasonCode === "ready"
            ? "真实下位机出货路径证据可用。"
            : "真实下位机出货路径被阻塞，或缺少真实硬件证据。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "恢复真实下位机路径后再进入生产试运营。",
      };
    case "whole_machine_maintenance_lock":
      return {
        code: productionPilotCheckCode(check),
        label: "整机维护锁",
        statusLabel,
        message:
          check.reasonCode === "clear"
            ? "整机维护锁已清除。"
            : "整机维护锁仍处于激活状态。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "确认硬件健康恢复并记录处理说明后，再清除整机维护锁。",
      };
    case "physical_stock_attestation":
      return {
        code: productionPilotCheckCode(check),
        label: "物理库存确认",
        statusLabel,
        message: stockAttestationMessage(check),
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : check.actionCode === "apply_planogram_then_attest_stock"
              ? "先让机器应用并确认平台货盘，再重新记录物理库存。"
              : check.actionCode === "record_active_planogram_stock_attestation"
                ? "按当前有效货盘重新记录物理库存。"
                : check.actionCode === "resolve_stock_state_inconsistencies"
                  ? "先处理货盘、货道启用状态和本地库存账不一致，再进入生产试运营。"
                  : "通过库存确认流程记录各货道的实际库存。",
      };
    case "recovery_drill":
      return {
        code: productionPilotCheckCode(check),
        label: "恢复演练",
        statusLabel,
        message:
          check.reasonCode === "ready"
            ? "支付和出货恢复演练已完成。"
            : "缺少支付或出货恢复演练证据。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "完成受保护的支付恢复和出货恢复演练后再进入生产试运营。",
      };
    case "managed_machine_update":
      return {
        code: productionPilotCheckCode(check),
        label: "托管机器更新",
        statusLabel,
        message:
          check.reasonCode === "ready"
            ? "托管机器更新能力已验证。"
            : "缺少托管更新或回滚能力证据。",
        operatorAction:
          check.actionCode === "continue_daily_inspection"
            ? "继续日常巡检。"
            : "验证机器端托管更新和回滚能力后再进入生产试运营。",
      };
    default:
      return assertNever(check);
  }
}
