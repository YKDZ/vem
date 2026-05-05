import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentProviderRegistry } from "./payment-provider.registry";

@Module({
  imports: [ConfigModule],
  providers: [MockPaymentProvider, PaymentProviderRegistry],
  exports: [MockPaymentProvider, PaymentProviderRegistry],
})
export class PaymentProvidersModule {}
