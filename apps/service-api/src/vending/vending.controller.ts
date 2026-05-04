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
import { VendingService } from "./vending.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@ApiTags("vending")
@ApiBearerAuth()
@Controller("vending-commands")
export class VendingController {
  constructor(private readonly vendingService: VendingService) {}

  @RequirePermissions("machines.command")
  @Get()
  async listCommands(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.vendingService.listCommands(query);
  }

  @RequirePermissions("machines.command")
  @Post(":id/retry")
  async retry(@Param("id", ParseUUIDPipe) id: string) {
    return await this.vendingService.retryCommand(id);
  }
}
