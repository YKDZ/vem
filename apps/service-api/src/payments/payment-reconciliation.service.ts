import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { PaymentsService } from "./payments.service";

@Injectable()
export class PaymentReconciliationService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PaymentsService)
    private readonly paymentsService: PaymentsService,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.paymentReconcileIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.paymentsService
        .reconcilePendingPayments()
        .catch((error: unknown) => {
          this.logger.warn(
            `reconcilePendingPayments failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, intervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
