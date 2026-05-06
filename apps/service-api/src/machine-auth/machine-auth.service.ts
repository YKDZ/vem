import type { MachineAuthTokenRequest } from "@vem/shared";

import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { and, eq, isNull, machines, type DrizzleClient } from "@vem/db";

import type { AuthenticatedMachine } from "./current-machine.decorator";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineCredentialService } from "./machine-credential.service";

export type MachineJwtPayload = {
  sub: string;
  code: string;
  typ: "machine";
  ver: number;
};

@Injectable()
export class MachineAuthService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly machineCredentialService: MachineCredentialService,
  ) {}

  async issueToken(input: MachineAuthTokenRequest) {
    const [machine] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        status: machines.status,
        secretHash: machines.secretHash,
        secretVersion: machines.secretVersion,
        credentialRevokedAt: machines.credentialRevokedAt,
      })
      .from(machines)
      .where(
        and(eq(machines.code, input.machineCode), isNull(machines.deletedAt)),
      );

    if (
      !machine ||
      machine.status === "disabled" ||
      machine.credentialRevokedAt ||
      !machine.secretHash ||
      !this.machineCredentialService.verifyMachineSecret(
        input.machineSecret,
        machine.secretHash,
      )
    ) {
      throw new UnauthorizedException("Invalid machine credentials");
    }

    const payload: MachineJwtPayload = {
      sub: machine.id,
      code: machine.code,
      typ: "machine",
      ver: machine.secretVersion,
    };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.machineJwtSecret,
      expiresIn: this.config.machineAccessTtlSeconds,
    });

    return {
      accessToken,
      tokenType: "Bearer" as const,
      expiresInSeconds: this.config.machineAccessTtlSeconds,
      machine: {
        id: machine.id,
        code: machine.code,
        status: machine.status,
      },
    };
  }

  async verifyToken(token: string): Promise<AuthenticatedMachine> {
    try {
      const payload = await this.jwtService.verifyAsync<MachineJwtPayload>(
        token,
        {
          secret: this.config.machineJwtSecret,
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
          secretVersion: machines.secretVersion,
          credentialRevokedAt: machines.credentialRevokedAt,
        })
        .from(machines)
        .where(
          and(
            eq(machines.id, payload.sub),
            eq(machines.code, payload.code),
            isNull(machines.deletedAt),
          ),
        );
      if (
        !machine ||
        machine.status === "disabled" ||
        machine.credentialRevokedAt ||
        machine.secretVersion !== payload.ver
      ) {
        throw new UnauthorizedException("Invalid machine token");
      }
      return machine;
    } catch {
      throw new UnauthorizedException("Invalid machine token");
    }
  }
}
