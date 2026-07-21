import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ConfigModule } from "../config/config.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentProvidersModule } from "../payments/payment-providers.module";
import { EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER } from "./external-natural-environment.provider";
import { MachinesController } from "./machines.controller";
import { MachinesService } from "./machines.service";
import { QweatherConfigController } from "./qweather-config.controller";
import { QweatherConfigService } from "./qweather-config.service";
import { QWeatherExternalNaturalEnvironmentProvider } from "./qweather-external-natural-environment.provider";

@Module({
  imports: [
    MachineAuthModule,
    AuditModule,
    MqttModule,
    ConfigModule,
    PaymentProvidersModule,
    NotificationsModule,
  ],
  controllers: [MachinesController, QweatherConfigController],
  providers: [
    MachinesService,
    QweatherConfigService,
    QWeatherExternalNaturalEnvironmentProvider,
    {
      provide: EXTERNAL_NATURAL_ENVIRONMENT_PROVIDER,
      useExisting: QWeatherExternalNaturalEnvironmentProvider,
    },
  ],
  exports: [MachinesService, QweatherConfigService],
})
export class MachinesModule {}
