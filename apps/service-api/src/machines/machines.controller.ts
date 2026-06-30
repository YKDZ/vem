import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createMachineSchema,
  createMachineSlotSchema,
  generateMachineClaimCodeRequestSchema,
  machineClaimRequestSchema,
  machineEnvironmentControlRequestSchema,
  pageQuerySchema,
  publishMachinePlanogramVersionSchema,
  updateMachineSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  CurrentMachine,
  type AuthenticatedMachine,
} from "../machine-auth/current-machine.decorator";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { MachinesService } from "./machines.service";

type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;
type PublishMachinePlanogramVersionInput = z.infer<
  typeof publishMachinePlanogramVersionSchema
>;
type MachineEnvironmentControlInput = z.infer<
  typeof machineEnvironmentControlRequestSchema
>;
type MachineClaimRequestInput = z.infer<typeof machineClaimRequestSchema>;
type GenerateMachineClaimCodeRequestInput = z.infer<
  typeof generateMachineClaimCodeRequestSchema
>;
type PageQueryInput = z.infer<typeof pageQuerySchema>;
type ExternalNaturalEnvironment = Awaited<
  ReturnType<MachinesService["getExternalNaturalEnvironmentForMachine"]>
>;

@ApiTags("machines")
@ApiBearerAuth()
@Controller("machines")
export class MachinesController {
  constructor(private readonly machinesService: MachinesService) {}

  @RequirePermissions("machines.read")
  @Get()
  async listMachines(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.machinesService.listMachines(query);
  }

  @RequirePermissions("machines.write")
  @Post()
  async createMachine(
    @Body(new ZodValidationPipe(createMachineSchema)) body: CreateMachineInput,
  ) {
    return await this.machinesService.createMachine(body);
  }

  @Public()
  @Post("claim")
  async claimMachine(
    @Body(new ZodValidationPipe(machineClaimRequestSchema))
    body: MachineClaimRequestInput,
  ) {
    return await this.machinesService.claimMachine(body);
  }

  @RequirePermissions("machines.write")
  @Patch(":id")
  async updateMachine(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMachineSchema)) body: UpdateMachineInput,
  ) {
    return await this.machinesService.updateMachine(id, body, admin.id);
  }

  @RequirePermissions("machines.read")
  @Get(":id/external-natural-environment")
  async getExternalNaturalEnvironment(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ExternalNaturalEnvironment> {
    return await this.machinesService.getExternalNaturalEnvironmentForMachine(
      id,
    );
  }

  @RequirePermissions("machines.read")
  @Get(":id")
  async getMachine(@Param("id", ParseUUIDPipe) id: string) {
    return await this.machinesService.getMachine(id);
  }

  @RequirePermissions("machines.write")
  @Post(":id/planogram-versions")
  async publishPlanogramVersion(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(publishMachinePlanogramVersionSchema))
    body: PublishMachinePlanogramVersionInput,
  ) {
    return await this.machinesService.publishMachinePlanogramVersion(
      id,
      body,
      admin.id,
    );
  }

  @RequirePermissions("machines.read")
  @Get(":id/planogram-versions")
  async listPlanogramVersions(@Param("id", ParseUUIDPipe) id: string) {
    return await this.machinesService.getMachinePlanogramVersions(id);
  }

  @RequirePermissions("machines.command")
  @Post(":id/commands/environment-control")
  async commandEnvironment(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(machineEnvironmentControlRequestSchema))
    body: MachineEnvironmentControlInput,
  ) {
    return await this.machinesService.commandEnvironment(id, body, admin.id);
  }

  @RequirePermissions("machines.read")
  @Get(":id/slots")
  async listSlots(@Param("id", ParseUUIDPipe) machineId: string) {
    return await this.machinesService.listSlots(machineId);
  }

  @RequirePermissions("machines.write")
  @Post(":id/slots")
  async createSlot(
    @Param("id", ParseUUIDPipe) machineId: string,
    @Body(new ZodValidationPipe(createMachineSlotSchema))
    body: CreateMachineSlotInput,
  ) {
    return await this.machinesService.createSlot(machineId, body);
  }

  @RequirePermissions("machines.manage-credentials")
  @Post(":id/credentials/rotate")
  async rotateMachineCredentials(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return await this.machinesService.rotateMachineCredentials(id, admin.id);
  }

  @RequirePermissions("machines.manage-credentials")
  @Post(":id/claim-codes")
  async generateClaimCode(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(generateMachineClaimCodeRequestSchema))
    body: GenerateMachineClaimCodeRequestInput = { purpose: "first_claim" },
  ) {
    return await this.machinesService.generateMachineClaimCode(
      id,
      admin.id,
      body,
    );
  }

  @RequirePermissions("machines.manage-credentials")
  @Get(":id/claim-codes")
  async listClaimCodes(@Param("id", ParseUUIDPipe) id: string) {
    return await this.machinesService.listMachineClaimCodes(id);
  }

  @RequirePermissions("machines.manage-credentials")
  @Get(":id/claim-codes/:claimCodeId")
  async getClaimCode(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("claimCodeId", ParseUUIDPipe) claimCodeId: string,
  ) {
    return await this.machinesService.getMachineClaimCode(id, claimCodeId);
  }

  @RequirePermissions("machines.manage-credentials")
  @Post(":id/claim-codes/:claimCodeId/revoke")
  async revokeClaimCode(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("claimCodeId", ParseUUIDPipe) claimCodeId: string,
  ) {
    return await this.machinesService.revokeMachineClaimCode(
      id,
      claimCodeId,
      admin.id,
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":code/external-natural-environment")
  async getOwnExternalNaturalEnvironment(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ): Promise<ExternalNaturalEnvironment> {
    if (code !== machine.code) {
      throw new ForbiddenException("Machine can only read its own environment");
    }
    return await this.machinesService.getExternalNaturalEnvironmentForMachineCode(
      machine.code,
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":code/planogram-versions/published")
  async getPublishedPlanogramVersion(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ) {
    return await this.machinesService.getPublishedPlanogramByMachineCode(
      code === machine.code ? machine.code : "__forbidden__",
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post(":code/planogram-versions/:planogramVersion/ack")
  async acknowledgePlanogramVersion(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
    @Param("planogramVersion") planogramVersion: string,
  ) {
    return await this.machinesService.acknowledgeMachinePlanogramVersion(
      code === machine.code ? machine.code : "__forbidden__",
      planogramVersion,
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":code/catalog")
  async getMachineCatalog(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ) {
    return await this.machinesService.getCatalogByMachineCode(
      code === machine.code ? machine.code : "__forbidden__",
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":code/stock-snapshot")
  async getMachineStockSnapshot(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ) {
    return await this.machinesService.getStockSnapshotByMachineCode(
      code === machine.code ? machine.code : "__forbidden__",
    );
  }
}
