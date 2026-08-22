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
import {
  adminListMachineOpsContract,
  adminMachineContractNoBodySchema,
  adminMachineOpsListQuerySchema,
  adminRequestMachineLogExportContract,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";
import type { AuthenticatedMachine } from "../machine-auth/current-machine.decorator";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
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

type AdminMachineOpsListQuery = z.infer<typeof adminMachineOpsListQuerySchema>;

@ApiTags("machine-ops")
@ApiBearerAuth()
@Controller()
export class MachineOpsController {
  constructor(private readonly machineOpsService: MachineOpsService) {}

  @RequirePermissions("machineOps.write")
  @AdminEndpointContract(adminRequestMachineLogExportContract)
  async requestLogExport(
    @Param(
      new ZodValidationPipe(
        adminRequestMachineLogExportContract.pathParamsSchema,
      ),
    )
    params: { machineId: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(adminMachineContractNoBodySchema))
    _body: z.infer<typeof adminMachineContractNoBodySchema>,
  ) {
    return this.machineOpsService.requestLogExport(params.machineId, admin.id);
  }

  @RequirePermissions("machineOps.read")
  @AdminEndpointContract(adminListMachineOpsContract)
  async listOps(
    @Query(new ZodValidationPipe(adminMachineOpsListQuerySchema))
    query: AdminMachineOpsListQuery,
  ) {
    return this.machineOpsService.listAllOps(query.machineId);
  }

  @Get("/machine-ops/pending")
  @Public()
  @UseGuards(MachineAuthGuard)
  async listPendingOps(@CurrentMachine() machine: AuthenticatedMachine) {
    return this.machineOpsService.listPendingForMachine(machine.id);
  }

  @Post("/machine-ops/:id/complete-log-export")
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

  @Post("/machine-ops/:id/fail")
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
