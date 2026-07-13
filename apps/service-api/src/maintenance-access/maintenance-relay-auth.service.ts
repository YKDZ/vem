import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  maintenanceRelayCredentialExchangeRequestSchema,
  maintenanceRelayCredentialExchangeResponseSchema,
} from "@vem/shared";
import { timingSafeEqual } from "node:crypto";

import { AppConfigService } from "../config/app-config.service";

type RelayTokenPayload = { actor: "maintenance_relay" };

const RELAY_TOKEN_ALGORITHM = "HS256";
const RELAY_TOKEN_AUDIENCE = "vem-maintenance-relay";
const RELAY_TOKEN_ISSUER = "vem-service-api";
const RELAY_TOKEN_TYPE = "JWT";

@Injectable()
export class MaintenanceRelayAuthService {
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async exchangeCredential(input: unknown) {
    const parsed =
      maintenanceRelayCredentialExchangeRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      !credentialsEqual(
        parsed.data.credential,
        this.config.maintenanceRelayCredential,
      )
    ) {
      throw new UnauthorizedException("Invalid maintenance relay credential");
    }
    const accessToken = await this.jwtService.signAsync(
      { actor: "maintenance_relay" } satisfies RelayTokenPayload,
      {
        algorithm: RELAY_TOKEN_ALGORITHM,
        audience: RELAY_TOKEN_AUDIENCE,
        secret: this.config.maintenanceRelayJwtSecret,
        expiresIn: this.config.maintenanceRelayTokenTtlSeconds,
        header: {
          alg: RELAY_TOKEN_ALGORITHM,
          typ: RELAY_TOKEN_TYPE,
        },
        issuer: RELAY_TOKEN_ISSUER,
      },
    );
    return maintenanceRelayCredentialExchangeResponseSchema.parse({
      actor: "maintenance_relay",
      accessToken,
      expiresAt: new Date(
        Date.now() + this.config.maintenanceRelayTokenTtlSeconds * 1000,
      ).toISOString(),
    });
  }

  async requireRelayActor(authorization: string | undefined): Promise<void> {
    const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
    if (!token) {
      throw new UnauthorizedException("Missing maintenance relay token");
    }
    try {
      const decoded = this.jwtService.decode<{
        header?: { alg?: string; typ?: string };
      }>(token, { complete: true });
      if (
        decoded?.header?.alg !== RELAY_TOKEN_ALGORITHM ||
        decoded.header.typ !== RELAY_TOKEN_TYPE
      ) {
        throw new Error("invalid token metadata");
      }
      const payload = await this.jwtService.verifyAsync<RelayTokenPayload>(
        token,
        {
          algorithms: [RELAY_TOKEN_ALGORITHM],
          audience: RELAY_TOKEN_AUDIENCE,
          issuer: RELAY_TOKEN_ISSUER,
          secret: this.config.maintenanceRelayJwtSecret,
        },
      );
      if (payload.actor !== "maintenance_relay") throw new Error("wrong actor");
    } catch {
      throw new UnauthorizedException("Invalid maintenance relay token");
    }
  }
}

function credentialsEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
