import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminNotificationListQuerySchema,
  notificationAdminNoBodySchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";

type NotificationListQuery = z.infer<typeof adminNotificationListQuerySchema>;

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermissions("notifications.read")
  @Get()
  async list(
    @Query(new ZodValidationPipe(adminNotificationListQuerySchema))
    query: NotificationListQuery,
  ) {
    return await this.notificationsService.list(query);
  }

  @RequirePermissions("notifications.write")
  @Post(":id/read")
  async markRead(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(notificationAdminNoBodySchema))
    _body: z.infer<typeof notificationAdminNoBodySchema>,
  ) {
    return await this.notificationsService.markRead(id);
  }
}
