import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createRoleSchema,
  pageQuerySchema,
  roleQuerySchema,
  updateRoleSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RolesService } from "./roles.service";

type RoleQuery = z.infer<typeof roleQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type CreateRoleInput = z.infer<typeof createRoleSchema>;
type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

const roleListQuerySchema = roleQuerySchema.extend(pageQuerySchema.shape);

@ApiTags("roles")
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @RequirePermissions("roles.write")
  @Get("roles")
  async list(
    @Query(new ZodValidationPipe(roleListQuerySchema))
    query: RoleQuery,
  ) {
    return await this.rolesService.list(query);
  }

  @RequirePermissions("roles.write")
  @Post("roles")
  async create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createRoleSchema))
    body: CreateRoleInput,
  ) {
    return await this.rolesService.create(admin.id, body);
  }

  @RequirePermissions("roles.write")
  @Patch("roles/:id")
  async update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema))
    body: UpdateRoleInput,
  ) {
    return await this.rolesService.update(admin.id, id, body);
  }

  @RequirePermissions("roles.write")
  @Get("permissions")
  getPermissions() {
    return this.rolesService.getPermissionCodes();
  }
}
