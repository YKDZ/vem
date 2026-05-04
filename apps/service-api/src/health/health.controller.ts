import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/public.decorator";
import { HealthService, type HealthStatus } from "./health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  async getHealth(): Promise<HealthStatus> {
    return await this.healthService.getHealth();
  }
}
