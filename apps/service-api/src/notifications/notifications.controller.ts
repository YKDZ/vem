import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListNotificationsContract,
  adminMarkNotificationReadContract,
  adminNotificationListQuerySchema,
  notificationAdminNoBodySchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { NotificationsService } from "./notifications.service";

type NotificationListQuery = z.infer<typeof adminNotificationListQuerySchema>;

@ApiTags("notifications")
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermissions("notifications.read")
  @AdminEndpointContract(adminListNotificationsContract)
  async list(@Query() query: NotificationListQuery) {
    return await this.notificationsService.list(query);
  }

  @RequirePermissions("notifications.write")
  @AdminEndpointContract(adminMarkNotificationReadContract)
  async markRead(
    @Param() params: { id: string },
    @Body() _body: z.infer<typeof notificationAdminNoBodySchema>,
  ) {
    return await this.notificationsService.markRead(params.id);
  }
}
