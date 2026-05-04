import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { createMachineOrderSchema } from "@vem/shared";
import { z } from "zod";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { OrdersService } from "./orders.service";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;

@ApiTags("machine-orders")
@Controller("machine-orders")
export class MachineOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Public()
  @Post()
  async createMachineOrder(
    @Body(new ZodValidationPipe(createMachineOrderSchema))
    body: CreateMachineOrderInput,
  ) {
    return await this.ordersService.createMachineOrder(body);
  }
}
