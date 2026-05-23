import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { PaymentOpsService } from "./payment-ops.service";

@Injectable()
export class PaymentReadinessStartupGateService implements OnModuleInit {
  private readonly logger = new Logger(
    PaymentReadinessStartupGateService.name,
  );

  constructor(
    private readonly config: AppConfigService,
    private readonly ops: PaymentOpsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.paymentProductionReadinessRequired) return;
    const readiness = await this.ops.getReadiness();
    if (readiness.status === "ready") {
      this.logger.log("Payment production readiness gate passed");
      return;
    }
    const failedCritical = readiness.checks
      .filter((check) => check.severity === "critical" && !check.passed)
      .map((check) => check.code)
      .join(", ");
    throw new Error(
      `Payment production readiness gate blocked startup: ${failedCritical}`,
    );
  }
}
