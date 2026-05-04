import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermissions("notifications.read")
  @Get()
  async list(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.notificationsService.list(query);
  }

  @RequirePermissions("notifications.write")
  @Post(":id/read")
  async markRead(@Param("id", ParseUUIDPipe) id: string) {
    return await this.notificationsService.markRead(id);
  }
}
