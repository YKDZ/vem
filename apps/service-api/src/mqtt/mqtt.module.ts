import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { MachineAuthModule } from "../machine-auth/machine-auth.module";
import { MqttSignatureService } from "./mqtt-signature.service";
import { MqttService } from "./mqtt.service";

@Module({
  imports: [ConfigModule, MachineAuthModule],
  providers: [MqttService, MqttSignatureService],
  exports: [MqttService, MqttSignatureService],
})
export class MqttModule {}
