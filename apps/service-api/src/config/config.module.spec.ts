import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AppConfigService } from "./app-config.service";

const validPools = {
  MAINTENANCE_RELAY_ADDRESS_POOL: "10.91.0.0/24",
  MAINTENANCE_RUNNER_ADDRESS_POOL: "10.91.1.0/24",
  MAINTENANCE_MAINTAINER_ADDRESS_POOL: "10.91.3.0/24",
  MAINTENANCE_MACHINE_ADDRESS_POOL: "10.91.16.0/20",
};

function configServiceFor(values: Record<string, string>) {
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

describe("ConfigModule maintenance address pools", () => {
  it("rejects an SSH target policy for a different deployment profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-target-policy-"));
    const targetPolicyPath = join(directory, "target-policy.json");
    writeFileSync(
      targetPolicyPath,
      JSON.stringify({
        profile: "production",
        targetMachineCodes: ["VEM-PRODUCTION-01"],
      }),
      { mode: 0o400 },
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        {
          provide: ConfigService,
          useValue: configServiceFor({
            ...validPools,
            NODE_ENV: "production",
            MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH: "/run/secrets/ssh-ca",
            MAINTENANCE_SSH_CA_PUBLIC_KEY_FINGERPRINT:
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            MAINTENANCE_SSH_PROFILE: "testbed",
            MAINTENANCE_SSH_TARGET_POLICY_PATH: targetPolicyPath,
          }),
        },
      ],
    }).compile();
    const config = moduleRef.get(AppConfigService);

    expect(() => config.maintenanceSshCa).toThrow(
      "Maintenance SSH target policy profile does not match the configured CA profile",
    );

    await moduleRef.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads automation trust material only from owner-read-only deployment files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-oidc-config-"));
    const policyPath = join(directory, "policy.json");
    const jwksPath = join(directory, "jwks.json");
    const secretPath = join(directory, "automation-jwt-secret");
    const policy = {
      repositoryId: "123456789",
      workflowIdentities: [
        {
          claimModel: "direct",
          workflowRef:
            "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
          allowedEnvironments: ["vem-maintenance-testbed"],
        },
      ],
      refs: ["refs/heads/main"],
      events: ["workflow_dispatch"],
      requireRefProtected: true,
      allowedRunnerPeerIds: ["11111111-1111-4111-8111-111111111111"],
      targetMachineCodes: ["VEM-TESTBED-RUNTIME-ACCEPTANCE"],
    };
    const jwks = {
      keys: [
        {
          kty: "RSA",
          kid: "mounted-key",
          n: "test-modulus",
          e: "AQAB",
        },
      ],
    };
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    writeFileSync(jwksPath, JSON.stringify(jwks), { mode: 0o400 });
    writeFileSync(secretPath, `${"s".repeat(48)}\n`, { mode: 0o400 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        {
          provide: ConfigService,
          useValue: configServiceFor({
            ...validPools,
            MAINTENANCE_GITHUB_OIDC_TRUST_POLICY_PATH: policyPath,
            MAINTENANCE_GITHUB_OIDC_JWKS_PATH: jwksPath,
            MAINTENANCE_AUTOMATION_JWT_SECRET_PATH: secretPath,
          }),
        },
      ],
    }).compile();
    const config = moduleRef.get(AppConfigService);

    expect(() => config.githubOidcTrustPolicy).toThrow("must be read-only");
    chmodSync(policyPath, 0o400);
    expect(config.githubOidcTrustPolicy).toEqual(policy);
    expect(config.githubOidcJwks).toEqual(jwks);
    expect(config.maintenanceAutomationJwtSecret).toBe("s".repeat(48));

    await moduleRef.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("parses maintenance address pools once during provider startup and caches them", async () => {
    const configService = configServiceFor(validPools);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    const config = moduleRef.get(AppConfigService);
    expect(config.maintenanceAddressPools).toBe(config.maintenanceAddressPools);
    expect(configService.get).toHaveBeenCalledTimes(4);

    await moduleRef.close();
  });

  it("fails module startup before serving requests when maintenance pools overlap", async () => {
    const configService = configServiceFor({
      ...validPools,
      MAINTENANCE_RUNNER_ADDRESS_POOL: "10.91.0.0/25",
    });

    await expect(
      Test.createTestingModule({
        providers: [
          AppConfigService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile(),
    ).rejects.toThrow(
      "Maintenance address pools relay and runner must not overlap",
    );
  });
});
