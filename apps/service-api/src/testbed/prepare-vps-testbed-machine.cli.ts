#!/usr/bin/env node

import {
  and,
  DrizzleDB,
  eq,
  inArray,
  machineClaimCodes,
  machines,
  sql,
  type DrizzleClient,
} from "@vem/db";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  digestMachineClaimCodeLookup,
  generateHumanMachineClaimCode,
  hashMachineClaimCodeVerifier,
} from "../machines/machine-claim-code.util";

export const DEFAULT_TESTBED_MACHINE_CODE = "VEM-TESTBED-WINVM-01";
export const DEFAULT_PLATFORM_TARGET = "vem-vps";
export const DEFAULT_VEM_VPS_API_BASE_URL = "http://118.25.104.160:26849/api";
export const DEFAULT_VEM_VPS_MQTT_URL = "mqtt://118.25.104.160:1883";
export const DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS = 600;
export const MIN_MACHINE_CLAIM_CODE_TTL_SECONDS = 60;
export const MAX_MACHINE_CLAIM_CODE_TTL_SECONDS = 3600;

const TESTBED_MACHINE_CODE_PATTERN = /^VEM-TESTBED-[A-Z0-9][A-Z0-9-]{0,47}$/;
const DEFAULT_MACHINE_CLAIM_LOOKUP_HMAC_KEY =
  "dev-machine-claim-lookup-hmac-key-change-me";

export type TestbedMachineRecord = {
  id: string;
  code: string;
};

export type PreparedTestbedClaimCode = {
  id: string;
  claimCode: string;
  expiresAt: Date;
};

export type PreparedTestbedMachineForFirstClaim = {
  machine: TestbedMachineRecord;
  claimCode: PreparedTestbedClaimCode;
  createdMachine: boolean;
  restoredMachine: boolean;
  closedClaimCodeIds: string[];
};

export type TestbedMachinePreparationRepository = {
  prepareMachineForFirstClaim(input: {
    machineCode: string;
    name: string;
    now: Date;
  }): Promise<PreparedTestbedMachineForFirstClaim>;
};

export type PrepareVpsTestbedMachineOptions = {
  machineCode?: string;
  platformTarget?: string;
  apiBaseUrl?: string;
  mqttUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  now?: Date;
};

export type PreparedVpsTestbedMachineIdentity = {
  machineCode: string;
  platformTarget: string;
  apiBaseUrl: string;
  mqtt: {
    url: string;
    clientId: string;
    topicPrefix: string;
    username?: string;
    password?: string;
  };
  claim: {
    claimCode: string;
    claimCodeId: string;
    expiresAt: string;
    path: "daemon-ipc:/v1/provisioning/claim";
  };
  reset: {
    createdMachine: boolean;
    restoredMachine: boolean;
    closedClaimCodeIds: string[];
    clearedExistingMachineCredentials: boolean;
  };
};

export function assertTestbedMachineCode(machineCode: string): string {
  const normalized = machineCode.trim().toUpperCase();
  if (!TESTBED_MACHINE_CODE_PATTERN.test(normalized)) {
    throw new Error(
      `Refusing to prepare non-testbed machine identity: ${machineCode}`,
    );
  }
  return normalized;
}

export function defaultTestbedMachineName(machineCode: string): string {
  const suffix = machineCode.replace(/^VEM-TESTBED-/, "").replaceAll("-", " ");
  return `Machine Runtime Testbed ${suffix}`;
}

export async function prepareVpsTestbedMachineIdentity(
  repository: TestbedMachinePreparationRepository,
  options: PrepareVpsTestbedMachineOptions = {},
): Promise<PreparedVpsTestbedMachineIdentity> {
  const machineCode = assertTestbedMachineCode(
    options.machineCode ?? DEFAULT_TESTBED_MACHINE_CODE,
  );
  if (options.mqttUsername && !options.mqttPassword) {
    throw new Error("MQTT_PASSWORD is required when MQTT_USERNAME is set");
  }
  const now = options.now ?? new Date();
  const prepared = await repository.prepareMachineForFirstClaim({
    machineCode,
    name: defaultTestbedMachineName(machineCode),
    now,
  });

  return {
    machineCode,
    platformTarget: options.platformTarget ?? DEFAULT_PLATFORM_TARGET,
    apiBaseUrl: options.apiBaseUrl ?? DEFAULT_VEM_VPS_API_BASE_URL,
    mqtt: {
      url: options.mqttUrl ?? DEFAULT_VEM_VPS_MQTT_URL,
      clientId: `vem-machine-${machineCode}`,
      topicPrefix: `vem/machines/${machineCode}`,
      ...(options.mqttUsername ? { username: options.mqttUsername } : {}),
      ...(options.mqttPassword ? { password: options.mqttPassword } : {}),
    },
    claim: {
      claimCode: prepared.claimCode.claimCode,
      claimCodeId: prepared.claimCode.id,
      expiresAt: prepared.claimCode.expiresAt.toISOString(),
      path: "daemon-ipc:/v1/provisioning/claim",
    },
    reset: {
      createdMachine: prepared.createdMachine,
      restoredMachine: prepared.restoredMachine,
      closedClaimCodeIds: prepared.closedClaimCodeIds,
      clearedExistingMachineCredentials: true,
    },
  };
}

export class DrizzleTestbedMachinePreparationRepository implements TestbedMachinePreparationRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly options: {
      machineClaimLookupHmacKey: string;
      claimCodeTtlSeconds: number;
    },
  ) {}

  async prepareMachineForFirstClaim(input: {
    machineCode: string;
    name: string;
    now: Date;
  }): Promise<PreparedTestbedMachineForFirstClaim> {
    const claimCode = generateHumanMachineClaimCode();
    const expiresAt = new Date(
      input.now.getTime() + this.options.claimCodeTtlSeconds * 1_000,
    );

    return await this.db.transaction(
      async (tx) => {
        let [machine] = await tx
          .select({
            id: machines.id,
            code: machines.code,
            deletedAt: machines.deletedAt,
          })
          .from(machines)
          .where(eq(machines.code, input.machineCode))
          .limit(1)
          .for("update");
        const createdMachine = machine === undefined;
        const restoredMachine =
          machine !== undefined && machine.deletedAt !== null;

        if (!machine) {
          [machine] = await tx
            .insert(machines)
            .values({
              code: input.machineCode,
              name: input.name,
              status: "offline",
              secretHash: null,
              secretVersion: 1,
              secretRotatedAt: null,
              credentialRevokedAt: null,
              mqttClientId: `vem-machine-${input.machineCode}`,
              mqttSigningSecretEncryptedJson: null,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning({
              id: machines.id,
              code: machines.code,
              deletedAt: machines.deletedAt,
            });
        }

        const [resetMachine] = await tx
          .update(machines)
          .set({
            name: input.name,
            status: "offline",
            secretHash: null,
            secretVersion: 1,
            secretRotatedAt: null,
            credentialRevokedAt: null,
            mqttClientId: `vem-machine-${input.machineCode}`,
            mqttSigningSecretEncryptedJson: null,
            deletedAt: null,
            updatedAt: input.now,
          })
          .where(eq(machines.id, machine.id))
          .returning({ id: machines.id, code: machines.code });
        if (!resetMachine) {
          throw new Error(
            `Testbed machine disappeared during reset: ${input.machineCode}`,
          );
        }

        const openClaimCodes = await tx
          .select({ id: machineClaimCodes.id })
          .from(machineClaimCodes)
          .where(
            and(
              eq(machineClaimCodes.machineId, machine.id),
              inArray(machineClaimCodes.state, ["pending", "locked"]),
            ),
          )
          .for("update");
        const openClaimCodeIds = openClaimCodes.map((open) => open.id);
        const closedClaimCodes =
          openClaimCodeIds.length === 0
            ? []
            : await tx
                .update(machineClaimCodes)
                .set({
                  state: sql`case when ${machineClaimCodes.expiresAt} <= ${input.now} then 'expired'::machine_claim_code_state else 'revoked'::machine_claim_code_state end`,
                  revokedAt: sql`case when ${machineClaimCodes.expiresAt} <= ${input.now} then ${machineClaimCodes.revokedAt} else ${input.now} end`,
                  updatedAt: input.now,
                })
                .where(inArray(machineClaimCodes.id, openClaimCodeIds))
                .returning({ id: machineClaimCodes.id });

        const [createdClaimCode] = await tx
          .insert(machineClaimCodes)
          .values({
            machineId: machine.id,
            lookupDigest: digestMachineClaimCodeLookup(
              claimCode,
              this.options.machineClaimLookupHmacKey,
            ),
            verifierHash: hashMachineClaimCodeVerifier(claimCode),
            purpose: "first_claim",
            state: "pending",
            failedAttemptCount: 0,
            maxFailedAttempts: 5,
            expiresAt,
            createdByAdminUserId: null,
          })
          .returning({ id: machineClaimCodes.id });

        return {
          machine: resetMachine,
          claimCode: { id: createdClaimCode.id, claimCode, expiresAt },
          createdMachine,
          restoredMachine,
          closedClaimCodeIds: closedClaimCodes.map((closed) => closed.id),
        };
      },
      { isolationLevel: "serializable" },
    );
  }
}

type CliOptions = PrepareVpsTestbedMachineOptions & {
  databaseUrl?: string;
  machineClaimLookupHmacKey: string;
  claimCodeTtlSeconds: number;
  outputPath?: string;
};

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readOptionalSecretFlag(
  args: string[],
  name: string,
): string | undefined {
  const value = readFlag(args, name);
  return value === "" ? undefined : value;
}

function parseClaimCodeTtlSeconds(
  args: string[],
  env: NodeJS.ProcessEnv,
): number {
  const raw =
    readFlag(args, "claim-code-ttl-seconds") ??
    env["MACHINE_CLAIM_CODE_TTL_SECONDS"] ??
    String(DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS);
  const ttl = Number(raw);
  if (!Number.isInteger(ttl)) {
    throw new Error("MACHINE_CLAIM_CODE_TTL_SECONDS must be an integer");
  }
  if (
    ttl < MIN_MACHINE_CLAIM_CODE_TTL_SECONDS ||
    ttl > MAX_MACHINE_CLAIM_CODE_TTL_SECONDS
  ) {
    throw new Error(
      `MACHINE_CLAIM_CODE_TTL_SECONDS must be between ${MIN_MACHINE_CLAIM_CODE_TTL_SECONDS} and ${MAX_MACHINE_CLAIM_CODE_TTL_SECONDS}`,
    );
  }
  return ttl;
}

export function parseCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const mqttUsername = readFlag(args, "mqtt-username") ?? env["MQTT_USERNAME"];
  const mqttPassword =
    readOptionalSecretFlag(args, "mqtt-password") ?? env["MQTT_PASSWORD"];
  if (mqttUsername && !mqttPassword) {
    throw new Error("MQTT_PASSWORD is required when MQTT_USERNAME is set");
  }

  return {
    databaseUrl: env["DATABASE_URL"],
    machineCode: readFlag(args, "machine-code") ?? env["TESTBED_MACHINE_CODE"],
    platformTarget:
      readFlag(args, "platform-target") ?? DEFAULT_PLATFORM_TARGET,
    apiBaseUrl:
      readFlag(args, "api-base-url") ??
      env["TESTBED_API_BASE_URL"] ??
      DEFAULT_VEM_VPS_API_BASE_URL,
    mqttUrl:
      readFlag(args, "mqtt-url") ?? env["MQTT_URL"] ?? DEFAULT_VEM_VPS_MQTT_URL,
    mqttUsername,
    mqttPassword,
    machineClaimLookupHmacKey:
      env["MACHINE_CLAIM_LOOKUP_HMAC_KEY"] ??
      DEFAULT_MACHINE_CLAIM_LOOKUP_HMAC_KEY,
    claimCodeTtlSeconds: parseClaimCodeTtlSeconds(args, env),
    outputPath: readFlag(args, "output"),
  };
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = new DrizzleDB(options.databaseUrl);
  await db.connect();
  try {
    const repository = new DrizzleTestbedMachinePreparationRepository(
      db.client,
      {
        machineClaimLookupHmacKey: options.machineClaimLookupHmacKey,
        claimCodeTtlSeconds: options.claimCodeTtlSeconds,
      },
    );
    const prepared = await prepareVpsTestbedMachineIdentity(
      repository,
      options,
    );
    const json = `${JSON.stringify(prepared, null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, json, "utf8");
    }
    process.stdout.write(json);
  } finally {
    await db.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  });
}
