import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { AlipayProvider } from "./alipay.provider";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { WeChatPayProvider } from "./wechat-pay.provider";

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    MockPaymentProvider,
    WeChatPayProvider,
    AlipayProvider,
    PaymentProviderRegistry,
    PaymentConfigSecretService,
    PaymentProviderConfigService,
  ],
  exports: [
    MockPaymentProvider,
    WeChatPayProvider,
    AlipayProvider,
    PaymentProviderRegistry,
    PaymentConfigSecretService,
    PaymentProviderConfigService,
  ],
})
export class PaymentProvidersModule {}
