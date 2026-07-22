import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adjustInventorySchema,
  createInventorySchema,
  inventoryQuerySchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { InventoryService } from "./inventory.service";

type InventoryQuery = z.infer<typeof inventoryQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
type CreateInventoryInput = z.infer<typeof createInventorySchema>;
type PageQueryInput = z.infer<typeof pageQuerySchema>;
const inventoryListQuerySchema = inventoryQuerySchema.extend(
  pageQuerySchema.shape,
);

@ApiTags("inventory")
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @RequirePermissions("inventory.read")
  @Get("inventories")
  async listInventories(
    @Query(new ZodValidationPipe(inventoryListQuerySchema))
    query: InventoryQuery,
  ) {
    return await this.inventoryService.listInventories(query);
  }

  @RequirePermissions("inventory.adjust")
  @Post("inventories")
  async createInventory(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createInventorySchema))
    body: CreateInventoryInput,
  ) {
    return await this.inventoryService.createInventory(admin.id, body);
  }

  @RequirePermissions("inventory.adjust")
  @Post("inventories/adjust")
  async adjust(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(adjustInventorySchema))
    body: AdjustInventoryInput,
  ) {
    return await this.inventoryService.adjust(admin.id, body);
  }

  @RequirePermissions("inventory.read")
  @Get("inventory-movements")
  async listMovements(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.inventoryService.listMovements(query);
  }
}
