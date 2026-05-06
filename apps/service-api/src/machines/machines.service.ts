import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  inventories,
  isNull,
  machineSlots,
  machines,
  productCategories,
  productVariants,
  products,
  sql,
  type DrizzleClient,
} from "@vem/db";
import {
  createMachineSchema,
  createMachineSlotSchema,
  pageQuerySchema,
  updateMachineSchema,
  type MachineRecommendationRequest,
} from "@vem/shared";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineCredentialService } from "../machine-auth/machine-credential.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;

@Injectable()
export class MachinesService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly machineCredentialService: MachineCredentialService,
    private readonly auditService: AuditService,
  ) {}

  async listMachines(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(machines)
      .where(isNull(machines.deletedAt))
      .orderBy(desc(machines.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(machines)
      .where(isNull(machines.deletedAt));

    return toPageResult(items, query, Number(totalRow.total));
  }

  async createMachine(input: CreateMachineInput) {
    const [created] = await this.db
      .insert(machines)
      .values({
        code: input.code,
        name: input.name,
        locationText: input.locationText ?? null,
        status: input.status,
        mqttClientId: input.mqttClientId ?? null,
      })
      .returning();
    return created;
  }

  async updateMachine(id: string, input: UpdateMachineInput) {
    const [updated] = await this.db
      .update(machines)
      .set({
        code: input.code,
        name: input.name,
        locationText: input.locationText,
        status: input.status,
        mqttClientId: input.mqttClientId,
        updatedAt: new Date(),
      })
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Machine not found");
    }
    return updated;
  }

  async listSlots(machineId: string) {
    return await this.db
      .select()
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machineId),
          isNull(machineSlots.deletedAt),
        ),
      )
      .orderBy(machineSlots.layerNo, machineSlots.cellNo);
  }

  async createSlot(machineId: string, input: CreateMachineSlotInput) {
    const [created] = await this.db
      .insert(machineSlots)
      .values({
        machineId,
        layerNo: input.layerNo,
        cellNo: input.cellNo,
        slotCode: input.slotCode,
        capacity: input.capacity,
        status: input.status,
      })
      .returning();
    return created;
  }

  async getCatalogByMachineCode(code: string) {
    return await this.db
      .select({
        machineCode: machines.code,
        slotId: machineSlots.id,
        slotCode: machineSlots.slotCode,
        layerNo: machineSlots.layerNo,
        cellNo: machineSlots.cellNo,
        inventoryId: inventories.id,
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        productDescription: products.description,
        coverImageUrl: products.coverImageUrl,
        categoryId: products.categoryId,
        categoryName: productCategories.name,
        sku: productVariants.sku,
        size: productVariants.size,
        color: productVariants.color,
        priceCents: productVariants.priceCents,
        availableQty: sql<number>`${inventories.onHandQty} - ${inventories.reservedQty}`,
        productSortOrder: products.sortOrder,
      })
      .from(machines)
      .innerJoin(
        machineSlots,
        and(
          eq(machineSlots.machineId, machines.id),
          isNull(machineSlots.deletedAt),
          eq(machineSlots.status, "enabled"),
        ),
      )
      .innerJoin(inventories, eq(inventories.slotId, machineSlots.id))
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.id, inventories.variantId),
          isNull(productVariants.deletedAt),
          eq(productVariants.status, "active"),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.id, productVariants.productId),
          isNull(products.deletedAt),
          eq(products.status, "active"),
        ),
      )
      .leftJoin(
        productCategories,
        eq(productCategories.id, products.categoryId),
      )
      .where(
        and(
          eq(machines.code, code),
          isNull(machines.deletedAt),
          inArray(machines.status, ["online", "maintenance"]),
          sql`${inventories.onHandQty} - ${inventories.reservedQty} > 0`,
        ),
      )
      .orderBy(products.sortOrder, machineSlots.layerNo, machineSlots.cellNo);
  }

  async getRecommendations(code: string, input: MachineRecommendationRequest) {
    const catalog = await this.getCatalogByMachineCode(code);
    return catalog
      .map((item) => {
        const warmWeatherBoost =
          input.profileSnapshot.weather === "hot" &&
          [item.categoryName, item.productName, item.productDescription]
            .filter(Boolean)
            .some((value) => value!.includes("饮") || value!.includes("短袖"))
            ? 20
            : 0;
        const stockBoost = Math.min(item.availableQty, 10);
        const sortBoost = Math.max(0, 100 - item.productSortOrder);
        const score = sortBoost + stockBoost + warmWeatherBoost;
        return {
          ...item,
          recommendationScore: score,
          recommendationReason:
            warmWeatherBoost > 0
              ? "匹配当前天气和库存"
              : "按商品排序和可售库存推荐",
        };
      })
      .sort(
        (left, right) => right.recommendationScore - left.recommendationScore,
      )
      .slice(0, input.limit);
  }

  async rotateMachineCredentials(id: string, adminUserId: string) {
    const [current] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        secretVersion: machines.secretVersion,
      })
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)));
    if (!current) {
      throw new NotFoundException("Machine not found");
    }

    const bundle = this.machineCredentialService.createBundle();
    const nextVersion = current.secretVersion + 1;
    const [updated] = await this.db
      .update(machines)
      .set({
        secretHash: bundle.secretHash,
        secretVersion: nextVersion,
        secretRotatedAt: new Date(),
        credentialRevokedAt: null,
        mqttSigningSecretEncryptedJson:
          bundle.mqttSigningSecretEncryptedJson as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, current.id))
      .returning({ id: machines.id, code: machines.code });

    await this.auditService.record({
      adminUserId,
      action: "machines.credentials.rotate",
      resourceType: "machine",
      resourceId: current.id,
      afterJson: { machineCode: current.code, secretVersion: nextVersion },
    });

    return {
      machineId: updated.id,
      machineCode: updated.code,
      secretVersion: nextVersion,
      machineSecret: bundle.machineSecret,
      mqttSigningSecret: bundle.mqttSigningSecret,
    };
  }
}
