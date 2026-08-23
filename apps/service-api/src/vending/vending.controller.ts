import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListVendingCommandsContract,
  adminResolveVendingCommandContract,
  manualDispenseResolutionSchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { toVendingCommandPageResponse } from "./vending.contract-mappers";
import { VendingService } from "./vending.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@ApiTags("vending")
@ApiBearerAuth()
@Controller()
export class VendingController {
  constructor(private readonly vendingService: VendingService) {}

  @RequirePermissions("machines.command")
  @AdminEndpointContract(adminListVendingCommandsContract)
  async listCommands(@Query() query: PageQueryInput) {
    return toVendingCommandPageResponse(
      await this.vendingService.listCommands(query),
    );
  }

  @RequirePermissions("machines.command")
  @AdminEndpointContract(adminResolveVendingCommandContract)
  async resolve(
    @Param() params: { id: string },
    @Body() body: z.infer<typeof manualDispenseResolutionSchema>,
  ) {
    return await this.vendingService.resolveCommand(params.id, body);
  }
}
