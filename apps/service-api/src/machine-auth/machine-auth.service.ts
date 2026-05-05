import type { MachineAuthTokenRequest } from "@vem/shared";

import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { and, eq, isNull, machines, type DrizzleClient } from "@vem/db";
import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthenticatedMachine } from "./current-machine.decorator";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export type MachineJwtPayload = {
  sub: string;
  code: string;
  typ: "machine";
};

@Injectable()
export class MachineAuthService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async issueToken(input: MachineAuthTokenRequest) {
    if (
      !this.sameSecret(input.machineSecret, this.config.machineSharedSecret)
    ) {
      throw new UnauthorizedException("Invalid machine credentials");
    }

    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code, status: machines.status })
      .from(machines)
      .where(
        and(eq(machines.code, input.machineCode), isNull(machines.deletedAt)),
      );
    if (!machine || machine.status === "disabled") {
      throw new UnauthorizedException("Invalid machine credentials");
    }

    const payload: MachineJwtPayload = {
      sub: machine.id,
      code: machine.code,
      typ: "machine",
    };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.machineSharedSecret,
      expiresIn: this.config.machineAccessTtlSeconds,
    });

    return {
      accessToken,
      tokenType: "Bearer" as const,
      expiresInSeconds: this.config.machineAccessTtlSeconds,
      machine,
    };
  }

  async verifyToken(token: string): Promise<AuthenticatedMachine> {
    try {
      const payload = await this.jwtService.verifyAsync<MachineJwtPayload>(
        token,
        {
          secret: this.config.machineSharedSecret,
        },
      );
      if (payload.typ !== "machine") {
        throw new UnauthorizedException("Invalid machine token");
      }
      const [machine] = await this.db
        .select({
          id: machines.id,
          code: machines.code,
          status: machines.status,
        })
        .from(machines)
        .where(
          and(
            eq(machines.id, payload.sub),
            eq(machines.code, payload.code),
            isNull(machines.deletedAt),
          ),
        );
      if (!machine || machine.status === "disabled") {
        throw new UnauthorizedException("Invalid machine token");
      }
      return machine;
    } catch {
      throw new UnauthorizedException("Invalid machine token");
    }
  }

  private sameSecret(actual: string, expected: string): boolean {
    const actualHash = createHash("sha256").update(actual).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actualHash, expectedHash);
  }
}
