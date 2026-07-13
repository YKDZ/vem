import { Body, Controller, Get, Headers, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/public.decorator";
import { MaintenanceAccessService } from "./maintenance-access.service";
import { MaintenanceRelayAuthService } from "./maintenance-relay-auth.service";

@ApiTags("maintenance-relay")
@Controller("maintenance-relay")
@Public()
export class MaintenanceRelayController {
  constructor(
    private readonly relayAuth: MaintenanceRelayAuthService,
    private readonly maintenanceAccess: MaintenanceAccessService,
  ) {}

  @Post("credential-exchange")
  async exchangeCredential(@Body() body: unknown) {
    return await this.relayAuth.exchangeCredential(body);
  }

  @Get("desired-state")
  @ApiBearerAuth()
  async getDesiredState(
    @Headers("authorization") authorization: string | undefined,
  ) {
    await this.relayAuth.requireRelayActor(authorization);
    return await this.maintenanceAccess.getRelayDesiredState();
  }

  @Post("observed-state")
  @ApiBearerAuth()
  async reportObservedState(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    await this.relayAuth.requireRelayActor(authorization);
    return await this.maintenanceAccess.reportRelayObservedState(body);
  }
}
