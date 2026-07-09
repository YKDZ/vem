import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { orderPaymentStates } from "./enums/order-status";
import { paymentCodeAttemptStatuses } from "./enums/payment-status";
import { orderRecoveryActionSchema } from "./schemas/orders";

const currentDir = dirname(fileURLToPath(import.meta.url));
const whitepaperPath = resolve(
  currentDir,
  "../../../public/v1-operations-whitepaper.md",
);
const realPaymentRunbookPath = resolve(
  currentDir,
  "../../../public/real-payment-refund-recovery-pilot.md",
);
const productionPilotSopPath = resolve(
  currentDir,
  "../../../public/production-pilot-sop.md",
);
const nearFieldCustomerSpeakerRunbookPath = resolve(
  currentDir,
  "../../../public/near-field-customer-speaker-acceptance.md",
);

function readWhitepaper(): string {
  return readFileSync(whitepaperPath, "utf8");
}

function readProductionPilotSop(): string {
  return readFileSync(productionPilotSopPath, "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(content: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n`);
  const match = content.match(pattern);
  expect(match, `missing SOP section ${heading}`).not.toBeNull();

  const start = (match?.index ?? 0) + (match?.[0].length ?? 0);
  const nextHeading = content.slice(start).search(/\n## /);
  return nextHeading === -1
    ? content.slice(start)
    : content.slice(start, start + nextHeading);
}

describe("public V1 operations whitepaper", () => {
  it("is present in the public artifact path and maps recovery states to shipped surfaces", () => {
    const content = readWhitepaper();

    expect(content).toContain("# VEM V1 运维白皮书");
    expect(content).toContain("/orders");
    expect(content).toContain("/payments");
    expect(content).toContain("/machines/:id");
    expect(content).toContain("机器 UI `#/maintenance`");

    const requiredTokens = [
      "支付结果对账",
      "付款码尝试",
      "退款决策",
      "出货结果未知",
      "库存异常复核案例",
      "整机维护锁",
      "`POST /api/orders/:id/recovery-actions`",
      "`POST /api/payments/:id/reconcile`",
      "`POST /api/payments/refunds/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/reverse`",
      "`POST /v1/maintenance/whole-machine-lock/clear`",
      "`accept_machine_stock`",
      "`reject_machine_stock`",
      "`manual_correct`",
      "`clearBlocker`",
      "`PAYMENT_MOCK_ENABLED=false`",
      "`NO_PAYMENT_OPTIONS`",
      "`PRODUCTION_DISPENSE_PATH_MOCK`",
      "`PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR`",
      "`SCANNER_UNAVAILABLE`",
    ];
    for (const token of requiredTokens) {
      expect(content).toContain(token);
    }

    for (const action of orderRecoveryActionSchema.shape.action.options) {
      expect(content).toContain(`\`${action}\``);
    }

    for (const state of ["awaiting_payment", "paid"] as const) {
      expect(orderPaymentStates).toContain(state);
      expect(content).toContain(`支付状态 \`${state}\``);
    }

    for (const status of [
      "unknown",
      "user_confirming",
      "querying",
      "manual_handling",
    ] as const) {
      expect(paymentCodeAttemptStatuses).toContain(status);
      expect(content).toContain(status);
    }

    expect(content).not.toContain("/api/admin");
    expect(content).not.toContain("Payment State `pending_payment`");
    expect(content).not.toMatch(/Payment Code Attempt[^\n|]*`processing`/);
    expect(content).not.toMatch(
      /直接(?:执行)?\s*SQL|手(?:动|工).*(?:SQL|数据库|补库)|(?:改|修改|修正|补|补丁|patch).*(?:数据库|DB|database)|(?:manual|direct).*(?:SQL|DB|database)|(?:DB|database)\s*patch/i,
    );
  });
});

describe("public real payment recovery pilot runbook", () => {
  it("documents operator surfaces and avoids developer-only recovery", () => {
    const content = readFileSync(realPaymentRunbookPath, "utf8");

    for (const token of [
      "`GET /api/payments/ops/readiness`",
      "`GET /api/payments/ops/machines/:machineId/preflight`",
      "`POST /api/payments/:id/reconcile`",
      "`POST /api/payments/payment-code-attempts/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/reverse`",
      "`POST /api/payments/refunds/:id/query`",
      "`POST /api/orders/:id/recovery-actions`",
      "`request_refund`",
      "payment_code.scanner_runtime.ready",
      "操作者、原因",
      "不得暴露原始授权码",
    ]) {
      expect(content).toContain(token);
    }

    expect(content).not.toMatch(
      /直接(?:执行)?\s*SQL|手(?:动|工).*(?:SQL|数据库|补库)|(?:manual|direct).*(?:SQL|DB|database)|(?:DB|database)\s*patch/i,
    );
  });
});

describe("public production pilot SOP", () => {
  it("is executable by non-developer operators through published surfaces", () => {
    const content = readProductionPilotSop();

    for (const token of [
      "# VEM 生产试点标准作业流程",
      "每日检查是必需步骤",
      "第一版不包含外部通知服务",
      "顾客订单凭证",
      "每日检查",
      "启动",
      "补货与盘点",
      "支付恢复",
      "付款码恢复",
      "退款处理",
      "履约恢复",
      "维护锁恢复",
      "库存异常复核处理",
      "离线与网络恢复",
      "托管更新",
      "紧急远程访问",
      "顾客投诉处理",
      "现场演练清单",
      "管理后台",
      "机器运行界面",
      "机器维护界面",
      "`GET /api/payments/ops/readiness`",
      "`GET /api/payments/ops/machines/:machineId/preflight`",
      "`POST /api/payments/:id/reconcile`",
      "`POST /api/payments/payment-code-attempts/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/reverse`",
      "`POST /api/payments/refunds/:id/query`",
      "`POST /api/orders/:id/recovery-actions`",
      "`POST /v1/stock/attestation`",
      "`POST /v1/stock/movements`",
      "`GET /v1/sale-readiness`",
      "`POST /v1/maintenance/whole-machine-lock/clear`",
      "/machines/:id",
      "库存异常复核案例",
      "库存对账入口",
      "accept_machine_stock",
      "reject_machine_stock",
      "manual_correct",
      "clearBlocker",
      "request_refund",
      "confirm_dispensed",
      "confirm_not_dispensed",
      "compensation_dispense",
      "非开发操作员",
      "非开发操作员可以执行",
      "操作员姓名",
      "操作员角色",
      "跟进负责人",
      "跟进日期",
      "修正措施",
    ]) {
      expect(content).toContain(token);
    }

    expect(content).not.toMatch(
      /直接(?:执行)?\s*SQL|手(?:动|工).*(?:SQL|数据库|补库)|(?:manual|direct).*(?:SQL|DB|database)|(?:DB|database)\s*patch/i,
    );
    expect(content).not.toMatch(
      /(?:capture|record|photograph|screenshot|scan|store|保存|记录|拍摄|截图).{0,40}(?:raw auth code|auth code|付款码|支付码|payment credential|payment code credential|credential secret)/i,
    );
  });

  it("keeps developer and host-level recovery out of routine operator workflows", () => {
    const content = readProductionPilotSop();
    const emergencyRemoteAccess = section(content, "紧急远程访问");
    const routineOperatorWorkflow = content.replace(emergencyRemoteAccess, "");

    for (const pattern of [
      /\bpsql\b/i,
      /\bdocker\b/i,
      /(?:direct|manual|manually|直接|手动|手工).{0,50}(?:SQL|DB|database|数据库).{0,50}(?:patch|mutat|update|insert|delete|write|edit|change|补库|修改|修正|更新|删除)/i,
      /(?:SQL|DB|database|数据库).{0,50}(?:patch|mutat|update|insert|delete|write|edit|change|补库|修改|修正|更新|删除)/i,
      /(?:patch|mutat|update|insert|delete|write|edit|change|补库|修改|修正|更新|删除).{0,50}(?:SQL|DB|database|数据库)/i,
    ]) {
      expect(content).not.toMatch(pattern);
    }

    for (const pattern of [
      /\bssh\b/i,
      /Controlled Maintenance Ingress|WireGuard|relay/i,
      /主机级命令/,
    ]) {
      expect(routineOperatorWorkflow).not.toMatch(pattern);
      expect(emergencyRemoteAccess).toMatch(pattern);
    }
  });

  it("keeps customer-support evidence limited to safe payment identifiers", () => {
    const content = readProductionPilotSop();

    for (const pattern of [
      /phone number/i,
      /card (?:number|data|details)/i,
      /bank (?:card|account|data|details)/i,
      /provider secrets?/i,
      /full payment credentials?/i,
      /full auth(?:entication)? codes?/i,
      /raw auth(?:entication)? codes?/i,
      /raw payment codes?/i,
      /完整付款码|完整支付码|原始付款码|原始支付码/,
    ]) {
      expect(content).not.toMatch(pattern);
    }

    expect(content).toContain("顾客订单凭证");
  });
});

describe("public near-field customer speaker acceptance runbook", () => {
  it("documents field acceptance without turning audio into sale evidence", () => {
    const content = readFileSync(nearFieldCustomerSpeakerRunbookPath, "utf8");

    for (const token of [
      "# Near-Field Customer Speaker Field Acceptance Runbook",
      "Near-Field Customer Speaker",
      "Customer Audio Zone",
      "wired",
      "low-power",
      "directionally installed",
      "not Bluetooth",
      "not public-address style",
      "OS default audio output",
      "does not bind",
      "speaker device ID",
      "protected maintenance",
      "Machine Audio Test Playback",
      "Win10/Tauri production runtime",
      "requested",
      "started",
      "completed",
      "failed",
      "clear inside the Customer Audio Zone",
      "unobtrusive outside it",
      "human field acceptance",
      "not part of default E2E/CI",
    ]) {
      expect(content).toContain(token);
    }

    expect(content).toMatch(
      /Machine Audio playback success is customer-experience evidence only\.\s+It must not be treated as sale readiness evidence, payment evidence, dispensing evidence, refund evidence, or manual-handling evidence\./,
    );
  });
});
