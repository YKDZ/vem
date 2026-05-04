import { Module } from "@nestjs/common";

import { MqttModule } from "../mqtt/mqtt.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [MqttModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
