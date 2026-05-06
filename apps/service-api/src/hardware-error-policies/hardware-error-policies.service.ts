import { Inject, Injectable } from "@nestjs/common";
import { and, eq, hardwareErrorCodeConfigs, type DrizzleClient } from "@vem/db";
import {
  HARDWARE_ERROR_HANDLING,
  hardwareErrorCodeSchema,
  type HardwareErrorHandlingRule,
} from "@vem/shared";

import { DRIZZLE_CLIENT } from "../database/database.constants";

@Injectable()
export class HardwareErrorPoliciesService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async listPolicies() {
    return await this.db
      .select()
      .from(hardwareErrorCodeConfigs)
      .orderBy(hardwareErrorCodeConfigs.errorCode);
  }

  async getPolicy(
    errorCode: string | null,
  ): Promise<HardwareErrorHandlingRule> {
    const key = errorCode ?? "NULL_ERROR";
    // Check DB first
    const [dbConfig] = await this.db
      .select()
      .from(hardwareErrorCodeConfigs)
      .where(
        and(
          eq(hardwareErrorCodeConfigs.errorCode, key),
          eq(hardwareErrorCodeConfigs.status, "enabled"),
        ),
      )
      .limit(1);

    if (dbConfig) {
      const parsedErrorCode = hardwareErrorCodeSchema.safeParse(
        dbConfig.errorCode,
      );
      return {
        errorCode: parsedErrorCode.success ? parsedErrorCode.data : null,
        restoreInventory: dbConfig.restoreInventory,
        faultSlot: dbConfig.faultSlot,
        requestRefund: dbConfig.requestRefund,
        createWorkOrder: dbConfig.createWorkOrder,
        severity: dbConfig.severity,
      };
    }

    // Fall back to shared defaults
    const defaults = HARDWARE_ERROR_HANDLING;
    return defaults[key] ?? defaults.NULL_ERROR;
  }

  async upsertPolicy(
    adminUserId: string,
    input: {
      errorCode?: string | null;
      restoreInventory: boolean;
      faultSlot: boolean;
      requestRefund: boolean;
      createWorkOrder: boolean;
      severity: "info" | "warning" | "critical";
    },
  ) {
    const key = input.errorCode ?? "NULL_ERROR";
    const [policy] = await this.db
      .insert(hardwareErrorCodeConfigs)
      .values({
        errorCode: key,
        restoreInventory: input.restoreInventory,
        faultSlot: input.faultSlot,
        requestRefund: input.requestRefund,
        createWorkOrder: input.createWorkOrder,
        severity: input.severity,
        status: "enabled",
        updatedByAdminUserId: adminUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: hardwareErrorCodeConfigs.errorCode,
        set: {
          restoreInventory: input.restoreInventory,
          faultSlot: input.faultSlot,
          requestRefund: input.requestRefund,
          createWorkOrder: input.createWorkOrder,
          severity: input.severity,
          updatedByAdminUserId: adminUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    return policy;
  }
}
