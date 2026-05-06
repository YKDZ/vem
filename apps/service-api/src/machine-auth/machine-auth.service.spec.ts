import type { DrizzleClient } from "@vem/db";
import type { MachineStatus } from "@vem/shared";

import { JwtService } from "@nestjs/jwt";
import { describe, expect, it } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MachineAuthService } from "./machine-auth.service";
import { MachineCredentialService } from "./machine-credential.service";
import {
  generateMachineSecret,
  hashMachineSecret,
} from "./machine-credentials.util";

const VALID_SECRET = generateMachineSecret();
const VALID_SECRET_HASH = hashMachineSecret(VALID_SECRET);

const mockMachine = {
  id: "00000000-0000-0000-0000-000000000001",
  code: "M001",
  status: "online" as MachineStatus,
  secretHash: VALID_SECRET_HASH as string | null,
  secretVersion: 1,
  credentialRevokedAt: null as Date | null,
};

function createService(overrides?: { dbResult?: typeof mockMachine | null }) {
  const dbResult =
    overrides && "dbResult" in overrides ? overrides.dbResult : mockMachine;
  const mockDb = {
    select: () => ({
      from: () => ({
        where: async () => Promise.resolve(dbResult ? [dbResult] : []),
      }),
    }),
  } as unknown as DrizzleClient;

  const MACHINE_JWT_SECRET =
    "local-machine-jwt-secret-change-before-production-min32";
  const mockConfig = {
    machineJwtSecret: MACHINE_JWT_SECRET,
    machineCredentialEncryptionKey:
      "local-cred-enc-key-change-before-production!",
    machineAccessTtlSeconds: 900,
  } as unknown as AppConfigService;

  const jwtService = new JwtService({});
  const credentialService = new MachineCredentialService(mockConfig);

  return new MachineAuthService(
    mockDb,
    jwtService,
    mockConfig,
    credentialService,
  );
}

describe("MachineAuthService", () => {
  it("issues a token with correct secret and active machine", async () => {
    const service = createService();
    const result = await service.issueToken({
      machineCode: "M001",
      machineSecret: VALID_SECRET,
    });
    expect(result.accessToken).toBeDefined();
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresInSeconds).toBe(900);
    expect(result.machine.code).toBe("M001");
  });

  it("throws UnauthorizedException with wrong secret", async () => {
    const service = createService();
    await expect(
      service.issueToken({
        machineCode: "M001",
        machineSecret: "vms_wrong-secret-that-is-definitely-not-correct",
      }),
    ).rejects.toThrow("Invalid machine credentials");
  });

  it("throws UnauthorizedException when secretHash is null", async () => {
    const service = createService({
      dbResult: { ...mockMachine, secretHash: null },
    });
    await expect(
      service.issueToken({
        machineCode: "M001",
        machineSecret: VALID_SECRET,
      }),
    ).rejects.toThrow("Invalid machine credentials");
  });

  it("throws UnauthorizedException when credentialRevokedAt is set", async () => {
    const service = createService({
      dbResult: {
        ...mockMachine,
        credentialRevokedAt: new Date("2026-01-01"),
      },
    });
    await expect(
      service.issueToken({
        machineCode: "M001",
        machineSecret: VALID_SECRET,
      }),
    ).rejects.toThrow("Invalid machine credentials");
  });

  it("throws UnauthorizedException for disabled machine", async () => {
    const service = createService({
      dbResult: { ...mockMachine, status: "disabled" as const },
    });
    await expect(
      service.issueToken({
        machineCode: "M001",
        machineSecret: VALID_SECRET,
      }),
    ).rejects.toThrow("Invalid machine credentials");
  });

  it("throws UnauthorizedException when machine not found", async () => {
    const service = createService({ dbResult: null });
    await expect(
      service.issueToken({
        machineCode: "NONEXISTENT",
        machineSecret: VALID_SECRET,
      }),
    ).rejects.toThrow("Invalid machine credentials");
  });

  describe("verifyToken", () => {
    it("rejects a token with mismatched secretVersion (old token after rotation)", async () => {
      const service = createService({
        dbResult: { ...mockMachine, secretVersion: 2 },
      });
      // Issue a token when secretVersion was 1
      const originalService = createService({
        dbResult: { ...mockMachine, secretVersion: 1 },
      });
      const { accessToken } = await originalService.issueToken({
        machineCode: "M001",
        machineSecret: VALID_SECRET,
      });

      // Now verify with a service that has secretVersion=2 (after rotation)
      await expect(service.verifyToken(accessToken)).rejects.toThrow(
        "Invalid machine token",
      );
    });

    it("rejects a revoked machine token", async () => {
      const service = createService({
        dbResult: { ...mockMachine, credentialRevokedAt: new Date() },
      });
      const originalService = createService();
      const { accessToken } = await originalService.issueToken({
        machineCode: "M001",
        machineSecret: VALID_SECRET,
      });

      await expect(service.verifyToken(accessToken)).rejects.toThrow(
        "Invalid machine token",
      );
    });
  });
});
