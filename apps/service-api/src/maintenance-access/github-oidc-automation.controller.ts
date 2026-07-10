import { Body, Controller, Get, Headers, Ip, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { issueMaintenanceSshCertificateRequestSchema } from "@vem/shared";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { GithubOidcAutomationService } from "./github-oidc-automation.service";

@ApiTags("maintenance-automation")
@ApiBearerAuth()
@Controller("maintenance-automation")
@Public()
export class GithubOidcAutomationController {
  constructor(private readonly automation: GithubOidcAutomationService) {}

  @Post("exchange")
  async exchange(@Body() body: unknown, @Ip() sourceIp: string) {
    return await this.automation.exchange(body, sourceIp);
  }

  @Post("session")
  async createSession(
    @Headers("authorization") authorization: string | undefined,
  ) {
    return await this.automation.createOwnSession(authorization);
  }

  @Get("session")
  async getSession(
    @Headers("authorization") authorization: string | undefined,
  ) {
    return await this.automation.getOwnSession(authorization);
  }

  @Post("session/revoke")
  async revokeSession(
    @Headers("authorization") authorization: string | undefined,
  ) {
    return await this.automation.revokeOwnSession(authorization);
  }

  @Post("session/ssh-certificate")
  async issueSshCertificate(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(issueMaintenanceSshCertificateRequestSchema))
    body: ReturnType<typeof issueMaintenanceSshCertificateRequestSchema.parse>,
  ) {
    return await this.automation.issueOwnSessionSshCertificate(
      authorization,
      body,
    );
  }
}
