import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCommandMachineEnvironmentContract,
  adminCreateMachineContract,
  adminCreateMachineSlotContract,
  adminGenerateMachineClaimCodeContract,
  adminGetMachineClaimCodeContract,
  adminGetMachineContract,
  adminGetMachineExternalNaturalEnvironmentContract,
  adminListMachineClaimCodesContract,
  adminListMachinePlanogramVersionsContract,
  adminListMachineSlotsContract,
  adminListMachinesContract,
  adminMachineContractNoBodySchema,
  adminPublishMachinePlanogramVersionContract,
  adminRevokeMachineClaimCodeContract,
  adminRotateMachineCredentialsContract,
  adminSecureDecommissionMachineContract,
  adminUpdateMachineContract,
  createMachineSchema,
  createMachineSlotSchema,
  generateMachineClaimCodeRequestSchema,
  machineClaimRequestSchema,
  machineEnvironmentControlRequestSchema,
  publishMachinePlanogramVersionSchema,
  updateMachineSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
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
type AdminMachineContractNoBodyInput = z.infer<
  typeof adminMachineContractNoBodySchema
>;
type ExternalNaturalEnvironment = Awaited<
  ReturnType<MachinesService["getExternalNaturalEnvironmentForMachine"]>
>;

@ApiTags("machines")
@ApiBearerAuth()
@Controller()
export class MachinesController {
  constructor(private readonly machinesService: MachinesService) {}

  @RequirePermissions("machines.read")
  @AdminEndpointContract(adminListMachinesContract)
  async listMachines(
    @Query() query: z.infer<typeof adminListMachinesContract.querySchema>,
  ) {
    return await this.machinesService.listMachines(query);
  }

  @RequirePermissions("machines.write")
  @AdminEndpointContract(adminCreateMachineContract)
  async createMachine(@Body() body: CreateMachineInput) {
    return await this.machinesService.createMachine(body);
  }

  @Public()
  @Post("/machines/claim")
  async claimMachine(
    @Body(new ZodValidationPipe(machineClaimRequestSchema))
    body: MachineClaimRequestInput,
  ) {
    return await this.machinesService.claimMachine(body);
  }

  @RequirePermissions("machines.write")
  @AdminEndpointContract(adminUpdateMachineContract)
  async updateMachine(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: UpdateMachineInput,
  ) {
    return await this.machinesService.updateMachine(params.id, body, admin.id);
  }

  @RequirePermissions("machines.read")
  @AdminEndpointContract(adminGetMachineExternalNaturalEnvironmentContract)
  async getExternalNaturalEnvironment(
    @Param() params: { id: string },
  ): Promise<ExternalNaturalEnvironment> {
    return await this.machinesService.getExternalNaturalEnvironmentForMachine(
      params.id,
    );
  }

  @RequirePermissions("machines.read")
  @AdminEndpointContract(adminGetMachineContract)
  async getMachine(@Param() params: { id: string }) {
    return await this.machinesService.getMachine(params.id);
  }

  @RequirePermissions("machines.write")
  @AdminEndpointContract(adminPublishMachinePlanogramVersionContract)
  async publishPlanogramVersion(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: PublishMachinePlanogramVersionInput,
  ) {
    return await this.machinesService.publishMachinePlanogramVersion(
      params.id,
      body,
      admin.id,
    );
  }

  @RequirePermissions("machines.read")
  @AdminEndpointContract(adminListMachinePlanogramVersionsContract)
  async listPlanogramVersions(@Param() params: { id: string }) {
    return await this.machinesService.getMachinePlanogramVersions(params.id);
  }

  @RequirePermissions("machines.command")
  @AdminEndpointContract(adminCommandMachineEnvironmentContract)
  async commandEnvironment(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: MachineEnvironmentControlInput,
  ) {
    return await this.machinesService.commandEnvironment(
      params.id,
      body,
      admin.id,
    );
  }

  @RequirePermissions("machines.read")
  @AdminEndpointContract(adminListMachineSlotsContract)
  async listSlots(@Param() params: { id: string }) {
    return await this.machinesService.listSlots(params.id);
  }

  @RequirePermissions("machines.write")
  @AdminEndpointContract(adminCreateMachineSlotContract)
  async createSlot(
    @Param() params: { id: string },
    @Body() body: CreateMachineSlotInput,
  ) {
    return await this.machinesService.createSlot(params.id, body);
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminRotateMachineCredentialsContract)
  async rotateMachineCredentials(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() _body: AdminMachineContractNoBodyInput,
  ) {
    return await this.machinesService.rotateMachineCredentials(
      params.id,
      admin.id,
    );
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminSecureDecommissionMachineContract)
  async secureDecommission(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() _body: AdminMachineContractNoBodyInput,
  ) {
    return await this.machinesService.secureDecommissionMachine(
      params.id,
      admin.id,
    );
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminGenerateMachineClaimCodeContract)
  async generateClaimCode(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body()
    body: GenerateMachineClaimCodeRequestInput = { purpose: "first_claim" },
  ) {
    return await this.machinesService.generateMachineClaimCode(
      params.id,
      admin.id,
      body,
    );
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminListMachineClaimCodesContract)
  async listClaimCodes(@Param() params: { id: string }) {
    return await this.machinesService.listMachineClaimCodes(params.id);
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminGetMachineClaimCodeContract)
  async getClaimCode(@Param() params: { id: string; claimCodeId: string }) {
    return await this.machinesService.getMachineClaimCode(
      params.id,
      params.claimCodeId,
    );
  }

  @RequirePermissions("machines.manage-credentials")
  @AdminEndpointContract(adminRevokeMachineClaimCodeContract)
  async revokeClaimCode(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string; claimCodeId: string },
    @Body() _body: AdminMachineContractNoBodyInput,
  ) {
    return await this.machinesService.revokeMachineClaimCode(
      params.id,
      params.claimCodeId,
      admin.id,
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get("/machines/:code/provisioning-profile")
  async getOwnProvisioningProfile(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ) {
    if (code !== machine.code) {
      throw new ForbiddenException(
        "Machine can only read its own provisioning profile",
      );
    }
    return await this.machinesService.getOwnProvisioningProfile(machine.id);
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get("/machines/by-code/:code/external-natural-environment")
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
  @Get("/machines/:code/planogram-versions/published")
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
  @Post("/machines/:code/planogram-versions/:planogramVersion/ack")
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
  @Get("/machines/:code/catalog")
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
  @Get("/machines/:code/stock-snapshot")
  async getMachineStockSnapshot(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
  ) {
    return await this.machinesService.getStockSnapshotByMachineCode(
      code === machine.code ? machine.code : "__forbidden__",
    );
  }
}
