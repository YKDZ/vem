import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  updateQweatherConfigSchema,
  type UpdateQweatherConfigInput,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { QweatherConfigService } from "./qweather-config.service";

@ApiTags("qweather-config")
@ApiBearerAuth()
@Controller("qweather-config")
export class QweatherConfigController {
  constructor(private readonly config: QweatherConfigService) {}

  @RequirePermissions("machines.read")
  @Get()
  async getConfig() {
    return await this.config.getAdminConfig();
  }

  @RequirePermissions("machines.write")
  @Put()
  async updateConfig(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(updateQweatherConfigSchema))
    body: UpdateQweatherConfigInput,
  ) {
    return await this.config.update(admin.id, body);
  }
}
