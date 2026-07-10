import { JwtService } from "@nestjs/jwt";
import { describe, expect, it } from "vitest";

import { MaintenanceRelayAuthService } from "./maintenance-relay-auth.service";

const credential = "r".repeat(32);
const secret = "s".repeat(32);
const config = {
  maintenanceRelayCredential: credential,
  maintenanceRelayJwtSecret: secret,
  maintenanceRelayTokenTtlSeconds: 300,
} as never;

describe("MaintenanceRelayAuthService", () => {
  it("issues only fixed HS256 JWT relay tokens", async () => {
    const jwt = new JwtService({});
    const service = new MaintenanceRelayAuthService(jwt, config);

    const exchange = await service.exchangeCredential({ credential });
    const decoded = jwt.decode<{
      header: { alg: string; typ?: string };
      payload: { actor: string; aud: string; iss: string };
    }>(exchange.accessToken, { complete: true });

    expect(decoded).toMatchObject({
      header: { alg: "HS256", typ: "JWT" },
      payload: {
        actor: "maintenance_relay",
        aud: "vem-maintenance-relay",
        iss: "vem-service-api",
      },
    });
    await expect(
      service.requireRelayActor(`Bearer ${exchange.accessToken}`),
    ).resolves.toBeUndefined();
    await expect(
      service.exchangeCredential({ credential: "x".repeat(32) }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects wrong actor/admin, token metadata, algorithm, and expiry", async () => {
    const jwt = new JwtService({});
    const service = new MaintenanceRelayAuthService(jwt, config);
    const sign = async (
      actor: string,
      options: Parameters<JwtService["signAsync"]>[1] = {},
    ) =>
      await jwt.signAsync(
        { actor },
        {
          algorithm: "HS256",
          audience: "vem-maintenance-relay",
          expiresIn: 300,
          issuer: "vem-service-api",
          secret,
          ...options,
        },
      );
    const invalidTokens = [
      await sign("admin"),
      await sign("maintenance_relay", { issuer: "other-service" }),
      await sign("maintenance_relay", { audience: "admin-ui" }),
      await sign("maintenance_relay", {
        algorithm: "HS384",
        header: { alg: "HS384", typ: "JWT" },
      }),
      await sign("maintenance_relay", {
        header: { alg: "HS256", typ: "ADMIN" },
      }),
      await sign("maintenance_relay", { expiresIn: -1 }),
    ];

    await Promise.all(
      invalidTokens.map((token) =>
        expect(
          service.requireRelayActor(`Bearer ${token}`),
        ).rejects.toMatchObject({ status: 401 }),
      ),
    );
  });
});
