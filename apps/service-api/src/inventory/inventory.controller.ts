import { Body, Controller, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminAdjustInventoryContract,
  adminCreateInventoryContract,
  adminListInventoryMovementsContract,
  adminListInventoriesContract,
  adjustInventorySchema,
  createInventorySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { InventoryService } from "./inventory.service";

type InventoryQuery = z.infer<typeof adminListInventoriesContract.querySchema>;
type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
type CreateInventoryInput = z.infer<typeof createInventorySchema>;
type PageQueryInput = z.infer<
  typeof adminListInventoryMovementsContract.querySchema
>;

@ApiTags("inventory")
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminListInventoriesContract)
  async listInventories(@Query() query: InventoryQuery) {
    return await this.inventoryService.listInventories(query);
  }

  @RequirePermissions("inventory.adjust")
  @AdminEndpointContract(adminCreateInventoryContract)
  async createInventory(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: CreateInventoryInput,
  ) {
    return await this.inventoryService.createInventory(admin.id, body);
  }

  @RequirePermissions("inventory.adjust")
  @AdminEndpointContract(adminAdjustInventoryContract)
  async adjust(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: AdjustInventoryInput,
  ) {
    return await this.inventoryService.adjust(admin.id, body);
  }

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminListInventoryMovementsContract)
  async listMovements(@Query() query: PageQueryInput) {
    return await this.inventoryService.listMovements(query);
  }
}
