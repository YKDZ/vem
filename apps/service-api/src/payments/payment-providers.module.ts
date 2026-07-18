import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { AlipaySdkClientFactory } from "./alipay-sdk.client";
import { AlipayProvider } from "./alipay.provider";
import { MockPaymentCodeTradeStore } from "./mock-payment-code-trade.store";
import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import { WeChatPayProvider } from "./wechat-pay.provider";

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    MockPaymentCodeTradeStore,
    MockPaymentProvider,
    WeChatPayProvider,
    AlipayProvider,
    AlipaySdkClientFactory,
    PaymentProviderRegistry,
    PaymentConfigSecretService,
    PaymentProviderConfigService,
  ],
  exports: [
    MockPaymentProvider,
    WeChatPayProvider,
    AlipayProvider,
    AlipaySdkClientFactory,
    PaymentProviderRegistry,
    PaymentConfigSecretService,
    PaymentProviderConfigService,
  ],
})
export class PaymentProvidersModule {}
