import type { DrizzleClient } from "@vem/db";

import { JwtService } from "@nestjs/jwt";
import { describe, expect, it } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MachineAuthService } from "./machine-auth.service";

const VALID_SECRET = "local-machine-shared-secret-change-before-production";

const mockMachine = {
  id: "00000000-0000-0000-0000-000000000001",
  code: "M001",
  status: "online" as const,
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

  const mockConfig = {
    machineSharedSecret: VALID_SECRET,
    machineAccessTtlSeconds: 900,
  } as unknown as AppConfigService;

  const jwtService = new JwtService({});

  return new MachineAuthService(mockDb, jwtService, mockConfig);
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
        machineSecret: "wrong-secret-that-is-definitely-not-the-correct-one",
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
});
