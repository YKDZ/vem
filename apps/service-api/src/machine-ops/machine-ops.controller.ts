import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentMachine } from "../machine-auth/current-machine.decorator";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { MachineOpsService } from "./machine-ops.service";

const completeLogExportSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
  base64: z.string().min(1),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024), // 10 MB limit
});

@ApiTags("machine-ops")
@ApiBearerAuth()
@Controller("machine-ops")
export class MachineOpsController {
  constructor(private readonly machineOpsService: MachineOpsService) {}

  @Post("machines/:machineId/export-logs")
  @RequirePermissions("machineOps.write")
  async requestLogExport(
    @Param("machineId", ParseUUIDPipe) machineId: string,
    @CurrentAdmin() admin: { userId: string },
  ) {
    return this.machineOpsService.requestLogExport(machineId, admin.userId);
  }

  @Get()
  @RequirePermissions("machineOps.read")
  async listOps(@Query("machineId") machineId?: string) {
    return this.machineOpsService.listAllOps(machineId);
  }

  @Get("pending")
  @Public()
  @UseGuards(MachineAuthGuard)
  async listPendingOps(@CurrentMachine() machine: AuthenticatedMachine) {
    return this.machineOpsService.listPendingForMachine(machine.id);
  }

  @Post(":id/complete-log-export")
  @Public()
  @UseGuards(MachineAuthGuard)
  async completeLogExport(
    @Param("id", ParseUUIDPipe) opId: string,
    @CurrentMachine() machine: AuthenticatedMachine,
    @Body(new ZodValidationPipe(completeLogExportSchema))
    body: z.infer<typeof completeLogExportSchema>,
  ) {
    await this.machineOpsService.acceptOp(opId, machine.id);
    return this.machineOpsService.completeLogExport(opId, machine.id, body);
  }

  @Post(":id/fail")
  @Public()
  @UseGuards(MachineAuthGuard)
  async failOp(
    @Param("id", ParseUUIDPipe) opId: string,
    @CurrentMachine() machine: AuthenticatedMachine,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().min(1) })))
    body: { reason: string },
  ) {
    return this.machineOpsService.failOp(opId, machine.id, body.reason);
  }
}
