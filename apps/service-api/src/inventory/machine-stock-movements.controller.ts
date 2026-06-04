import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  rawMachineStockMovementSchema,
  type RawMachineStockMovement,
} from "@vem/shared";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  CurrentMachine,
  type AuthenticatedMachine,
} from "../machine-auth/current-machine.decorator";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { MachineStockMovementsService } from "./machine-stock-movements.service";

@ApiTags("machine-stock-movements")
@Controller("machine-stock-movements")
export class MachineStockMovementsController {
  constructor(private readonly service: MachineStockMovementsService) {}

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post()
  async receiveRawMovement(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Body(new ZodValidationPipe(rawMachineStockMovementSchema))
    body: RawMachineStockMovement,
  ) {
    if (body.machineCode !== undefined && body.machineCode !== machine.code) {
      throw new BadRequestException(
        "machineCode must match authenticated machine",
      );
    }
    return await this.service.receiveRawMovement(machine, {
      ...body,
      machineCode: machine.code,
    });
  }
}
