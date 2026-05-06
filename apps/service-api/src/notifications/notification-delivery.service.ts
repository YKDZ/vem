import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  and,
  eq,
  notificationDeliveries,
  notificationTargets,
  notifications,
  type DrizzleClient,
} from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";

const POLL_INTERVAL_MS = 30_000;

@Injectable()
export class NotificationDeliveryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.deliverPending();
    }, POLL_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async deliverPending(): Promise<void> {
    try {
      const pending = await this.db
        .select({
          delivery: notificationDeliveries,
          notification: notifications,
          target: notificationTargets,
        })
        .from(notificationDeliveries)
        .innerJoin(
          notifications,
          eq(notificationDeliveries.notificationId, notifications.id),
        )
        .innerJoin(
          notificationTargets,
          eq(notificationDeliveries.targetId, notificationTargets.id),
        )
        .where(
          and(
            eq(notificationDeliveries.status, "pending"),
            eq(notificationTargets.status, "enabled"),
          ),
        )
        .limit(50);

      await Promise.all(pending.map(async (row) => this.deliver(row)));
    } catch (error) {
      this.logger.error("Delivery worker error", error);
    }
  }

  private async deliver(row: {
    delivery: typeof notificationDeliveries.$inferSelect;
    notification: typeof notifications.$inferSelect;
    target: typeof notificationTargets.$inferSelect;
  }): Promise<void> {
    try {
      await this.sendToTarget(row.target, row.notification);
      await this.db
        .update(notificationDeliveries)
        .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, row.delivery.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Delivery failed: ${reason}`);
      await this.db
        .update(notificationDeliveries)
        .set({
          status: "failed",
          failedReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(notificationDeliveries.id, row.delivery.id));
    }
  }

  private async sendToTarget(
    target: typeof notificationTargets.$inferSelect,
    notification: typeof notifications.$inferSelect,
  ): Promise<void> {
    if (target.type === "wechat") {
      const configJson = target.configJson;
      const webhookUrl = configJson["webhookUrl"];
      if (typeof webhookUrl !== "string") {
        throw new Error("WeChat notification target missing webhookUrl");
      }
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: `[${notification.severity}] ${notification.title}\n${notification.content}`,
          },
        }),
      });
      if (!resp.ok) {
        throw new Error(`WeChat webhook returned ${resp.status}`);
      }
    } else if (target.type === "in_app") {
      // In-app delivery is handled via the notifications list; mark as sent
      return;
    } else {
      throw new Error(`Unsupported notification target type: ${target.type}`);
    }
  }
}
