import type { Request } from "express";

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import type { AuthenticatedMachine } from "./current-machine.decorator";

import { MachineAuthService } from "./machine-auth.service";

@Injectable()
export class MachineAuthGuard implements CanActivate {
  constructor(private readonly machineAuthService: MachineAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { machine?: AuthenticatedMachine }>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Missing machine bearer token");
    }
    request.machine = await this.machineAuthService.verifyToken(token);
    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(" ") ?? [];
    return type === "Bearer" ? token : undefined;
  }
}
