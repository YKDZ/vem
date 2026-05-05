import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  machineAuthTokenRequestSchema,
  type MachineAuthTokenRequest,
} from "@vem/shared";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MachineAuthService } from "./machine-auth.service";

@ApiTags("machine-auth")
@Controller("machine-auth")
export class MachineAuthController {
  constructor(private readonly machineAuthService: MachineAuthService) {}

  @Public()
  @Post("token")
  async issueToken(
    @Body(new ZodValidationPipe(machineAuthTokenRequestSchema))
    body: MachineAuthTokenRequest,
  ) {
    return await this.machineAuthService.issueToken(body);
  }
}
