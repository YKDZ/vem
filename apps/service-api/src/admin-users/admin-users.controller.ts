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
  adminUserListQuerySchema,
  createAdminUserSchema,
  type AdminCreateUserRequest,
  type AdminUpdateUserRequest,
  type AdminUserListQuery,
  updateAdminUserSchema,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AdminUsersService } from "./admin-users.service";

@ApiTags("admin-users")
@ApiBearerAuth()
@Controller("admin-users")
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @RequirePermissions("adminUsers.read")
  @Get()
  async list(
    @Query(new ZodValidationPipe(adminUserListQuerySchema))
    query: AdminUserListQuery,
  ) {
    return await this.adminUsersService.list(query);
  }

  @RequirePermissions("adminUsers.write")
  @Post()
  async create(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createAdminUserSchema))
    body: AdminCreateUserRequest,
  ) {
    return await this.adminUsersService.create(admin.id, body);
  }

  @RequirePermissions("adminUsers.write")
  @Patch(":id")
  async update(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAdminUserSchema))
    body: AdminUpdateUserRequest,
  ) {
    return await this.adminUsersService.update(admin.id, id, body);
  }
}
