import { Injectable } from "@nestjs/common";

import { DatabaseHealth } from "../database/database.health";
import { MqttService } from "../mqtt/mqtt.service";

export type HealthStatus = {
  database: "ok";
  mqtt: "connected" | "disconnected";
};

@Injectable()
export class HealthService {
  constructor(
    private readonly databaseHealth: DatabaseHealth,
    private readonly mqttService: MqttService,
  ) {}

  async getHealth(): Promise<HealthStatus> {
    const database = await this.databaseHealth.ping();
    return {
      database,
      mqtt: this.mqttService.isConnected() ? "connected" : "disconnected",
    };
  }
}
