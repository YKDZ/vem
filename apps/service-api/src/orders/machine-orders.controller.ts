import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  createMachineOrderSchema,
  machineOrderStatusQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  CurrentMachine,
  type AuthenticatedMachine,
} from "../machine-auth/current-machine.decorator";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { OrdersService } from "./orders.service";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
type MachineOrderStatusQuery = z.infer<typeof machineOrderStatusQuerySchema>;

@ApiTags("machine-orders")
@Controller("machine-orders")
export class MachineOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post()
  async createMachineOrder(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Body(new ZodValidationPipe(createMachineOrderSchema))
    body: CreateMachineOrderInput,
  ) {
    return await this.ordersService.createMachineOrder({
      ...body,
      machineCode:
        body.machineCode === machine.code ? machine.code : "__forbidden__",
    });
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":orderNo/status")
  async getMachineOrderStatus(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("orderNo") orderNo: string,
    @Query(new ZodValidationPipe(machineOrderStatusQuerySchema))
    query: MachineOrderStatusQuery,
  ) {
    const machineCode =
      query.machineCode === machine.code ? machine.code : "__forbidden__";
    return await this.ordersService.getMachineOrderStatus(orderNo, {
      machineCode,
    });
  }
}
