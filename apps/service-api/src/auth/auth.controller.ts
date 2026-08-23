import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { adminGetCurrentAdminContract, loginRequestSchema } from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { CurrentAdmin } from "./current-admin.decorator";
import { Public } from "./public.decorator";

const refreshTokenRequestSchema = z.object({
  refreshToken: z.uuid(),
});

@ApiTags("auth")
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post("auth/login")
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema))
    body: z.infer<typeof loginRequestSchema>,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return await this.authService.login(body.username, body.password);
  }

  @ApiBearerAuth()
  @AdminEndpointContract(adminGetCurrentAdminContract)
  async me(
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<AuthenticatedAdmin> {
    return await this.authService.me(admin);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post("auth/refresh")
  async refresh(
    @Body(new ZodValidationPipe(refreshTokenRequestSchema))
    body: z.infer<typeof refreshTokenRequestSchema>,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return await this.authService.refresh(body.refreshToken);
  }
}
