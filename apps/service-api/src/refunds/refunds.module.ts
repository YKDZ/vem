import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { PaymentProvidersModule } from "../payments/payment-providers.module";
import { RefundsService } from "./refunds.service";

@Module({
  imports: [DatabaseModule, PaymentProvidersModule],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
