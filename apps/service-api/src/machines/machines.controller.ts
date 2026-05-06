import {
  Body,
  Controller,
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
  machineRecommendationRequestSchema,
  pageQuerySchema,
  updateMachineSchema,
  type MachineRecommendationRequest,
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
type PageQueryInput = z.infer<typeof pageQuerySchema>;

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

  @RequirePermissions("machines.write")
  @Patch(":id")
  async updateMachine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMachineSchema)) body: UpdateMachineInput,
  ) {
    return await this.machinesService.updateMachine(id, body);
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
  @Post(":code/recommendations")
  async getMachineRecommendations(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("code") code: string,
    @Body(new ZodValidationPipe(machineRecommendationRequestSchema))
    body: MachineRecommendationRequest,
  ) {
    return await this.machinesService.getRecommendations(
      code === machine.code ? machine.code : "__forbidden__",
      body,
    );
  }
}
