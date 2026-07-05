#!/usr/bin/env node

import {
  and,
  DrizzleDB,
  eq,
  inArray,
  inventories,
  machineClaimCodes,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machines,
  machineSlots,
  paymentProviders,
  productVariants,
  products,
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

const DEFAULT_MACHINE_CLAIM_LOOKUP_HMAC_KEY =
  "dev-machine-claim-lookup-hmac-key-change-me";
const DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS = 600;
const TESTBED_MACHINE_CODE_PATTERN = /^VEM-TESTBED-[A-Z0-9][A-Z0-9-]{0,47}$/;
const TESTBED_MACHINE_CODE_PREFIX_PATTERN =
  /^VEM-TESTBED-[A-Z0-9][A-Z0-9-]{0,40}$/;

type TestbedSlotSeed = {
  slotCode: string;
  layerNo: number;
  cellNo: number;
  capacity: number;
  onHandQty: number;
  lowStockThreshold: number;
  name: string;
  skuSuffix: string;
  size: string;
  color: string;
  priceCents: number;
};

const TESTBED_SLOTS: TestbedSlotSeed[] = [
  {
    slotCode: "A1",
    layerNo: 1,
    cellNo: 1,
    capacity: 8,
    onHandQty: 3,
    lowStockThreshold: 1,
    name: "Testbed Socks A1",
    skuSuffix: "A1",
    size: "REG",
    color: "black",
    priceCents: 3900,
  },
  {
    slotCode: "A2",
    layerNo: 1,
    cellNo: 2,
    capacity: 8,
    onHandQty: 3,
    lowStockThreshold: 1,
    name: "Testbed Socks A2",
    skuSuffix: "A2",
    size: "REG",
    color: "white",
    priceCents: 4900,
  },
];

export type PrepareEphemeralPlatformStackOptions = {
  runId: string;
  machineCodePrefix: string;
  databaseUrl: string;
  apiBaseUrl: string;
  mqttUrl: string;
  allowEphemeralTarget?: boolean;
  allowMockPayment?: boolean;
  runtimePaymentMockEnabled?: boolean;
  reset?: boolean;
  now?: Date;
};

export type PreparedRunData = {
  machine: {
    id: string;
    code: string;
    created: boolean;
  };
  claim: {
    id: string;
    claimCode: string;
    expiresAt: Date;
    closedClaimCodeIds: string[];
  };
  hardwareSlotTopology: {
    identity: string;
    version: string;
    slots: Array<{
      slotCode: string;
      layerNo: number;
      cellNo: number;
      capacity: number;
    }>;
  };
  products: Array<{
    productId: string;
    variantId: string;
    sku: string;
    name: string;
    priceCents: number;
  }>;
  planogram: {
    planogramVersion: string;
    status: "published";
    slotCount: number;
    inventory: Array<{
      slotCode: string;
      inventoryId: string;
      onHandQty: number;
      lowStockThreshold: number;
    }>;
  };
  payment: {
    ready: boolean;
    mockProviderStatus: "enabled" | "not_prepared";
    serviceRequiresPaymentMockEnabled: true;
    runtimePaymentMockEnabled: boolean;
    mockPaymentAcknowledged: boolean;
  };
};

export type EphemeralPlatformStackRepository = {
  prepareRun(input: {
    runId: string;
    machineCode: string;
    reset: boolean;
    now: Date;
    prepareMockPayment: boolean;
  }): Promise<PreparedRunData>;
};

export type EphemeralPlatformSetupEvidence = {
  runId: string;
  preparedAt: string;
  stack: {
    apiBaseUrl: string;
    mqttUrl: string;
    databaseTarget: "explicit";
  };
  testbedMachine: {
    id: string;
    code: string;
    created: boolean;
    claim: {
      claimCode: string;
      claimCodeId: string;
      expiresAt: string;
      path: "/api/machines/claim";
      closedClaimCodeIds: string[];
    };
  };
  hardwareSlotTopology: PreparedRunData["hardwareSlotTopology"];
  seededData: {
    products: PreparedRunData["products"];
    planogram: Omit<PreparedRunData["planogram"], "inventory">;
    stockSetup: PreparedRunData["planogram"]["inventory"];
    paymentReadiness: {
      ready: boolean;
      mockProviderStatus: "enabled" | "not_prepared";
      serviceRequiresPaymentMockEnabled: true;
      runtimePaymentMockEnabled: boolean;
      mockPaymentAcknowledged: boolean;
    };
  };
  verificationPaths: {
    provisioningClaim: "/api/machines/claim";
    machineAuthToken: "/api/machine-auth/token";
    publishedPlanogram: string;
    planogramAck: string;
    stockSnapshot: string;
    machineOrders: "/api/machine-orders";
  };
};

type CliOptions = PrepareEphemeralPlatformStackOptions & {
  outputPath?: string;
  machineClaimLookupHmacKey: string;
  claimCodeTtlSeconds: number;
};

const KNOWN_PRODUCTION_OR_VPS_HOSTS = new Set(["118.25.104.160"]);
const KNOWN_PRODUCTION_DATABASE_NAMES = new Set([
  "vem",
  "vem_prod",
  "vem_production",
  "vem-vps",
  "vem_vps",
]);

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function normalizeRunId(runId: string): string {
  const normalized = runId
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9-]/g, "-");
  const collapsed = normalized.replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed) throw new Error("--run-id must contain letters or numbers");
  if (collapsed.length > 32) {
    throw new Error("--run-id must normalize to at most 32 characters");
  }
  return collapsed;
}

function assertTestbedPrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase().replace(/-+$/g, "");
  if (!TESTBED_MACHINE_CODE_PREFIX_PATTERN.test(normalized)) {
    throw new Error(
      `Refusing to prepare non-testbed machine identity prefix: ${prefix}`,
    );
  }
  return normalized;
}

function testbedMachineCode(prefix: string, runId: string): string {
  const machineCode = `${assertTestbedPrefix(prefix)}-${normalizeRunId(runId)}`;
  if (!TESTBED_MACHINE_CODE_PATTERN.test(machineCode)) {
    throw new Error(
      `Refusing to prepare non-testbed machine identity: ${machineCode}`,
    );
  }
  return machineCode;
}

function requireOption(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message);
  return value;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function assertAllowedEphemeralTarget(
  target: { name: "database" | "api" | "mqtt"; flag: string },
  rawUrl: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${target.flag} must be a valid URL`);
  }

  if (KNOWN_PRODUCTION_OR_VPS_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing known production or VPS target for ${target.flag}: ${rawUrl}`,
    );
  }

  if (target.name === "database") {
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (KNOWN_PRODUCTION_DATABASE_NAMES.has(databaseName)) {
      throw new Error(
        `Refusing known production or VPS target for --database-url: ${databaseName}`,
      );
    }
  }
}

export function parseCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const databaseUrl = requireOption(
    readFlag(args, "database-url"),
    "--database-url is required",
  );
  const apiBaseUrl = requireOption(
    readFlag(args, "api-base-url"),
    "--api-base-url is required",
  );
  const mqttUrl = requireOption(
    readFlag(args, "mqtt-url"),
    "--mqtt-url is required",
  );
  const machineCodePrefix = requireOption(
    readFlag(args, "machine-code-prefix"),
    "--machine-code-prefix is required",
  );
  const runId = requireOption(readFlag(args, "run-id"), "--run-id is required");
  if (
    normalizeRunId(runId) === "LOCAL" ||
    normalizeRunId(runId) === "DEFAULT"
  ) {
    throw new Error("--run-id must be non-default");
  }
  if (!hasFlag(args, "allow-ephemeral-target")) {
    throw new Error("--allow-ephemeral-target is required");
  }
  if (!hasFlag(args, "allow-mock-payment")) {
    throw new Error("--allow-mock-payment is required");
  }
  assertAllowedEphemeralTarget(
    { name: "database", flag: "--database-url" },
    databaseUrl,
  );
  assertAllowedEphemeralTarget(
    { name: "api", flag: "--api-base-url" },
    apiBaseUrl,
  );
  assertAllowedEphemeralTarget({ name: "mqtt", flag: "--mqtt-url" }, mqttUrl);

  return {
    runId,
    machineCodePrefix,
    databaseUrl,
    apiBaseUrl,
    mqttUrl,
    allowEphemeralTarget: true,
    allowMockPayment: true,
    runtimePaymentMockEnabled: parseBooleanEnv(env["PAYMENT_MOCK_ENABLED"]),
    reset: hasFlag(args, "reset"),
    outputPath: readFlag(args, "output"),
    machineClaimLookupHmacKey:
      env["MACHINE_CLAIM_LOOKUP_HMAC_KEY"] ??
      DEFAULT_MACHINE_CLAIM_LOOKUP_HMAC_KEY,
    claimCodeTtlSeconds: Number(
      env["MACHINE_CLAIM_CODE_TTL_SECONDS"] ??
        DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS,
    ),
  };
}

export async function prepareEphemeralPlatformStack(
  repository: EphemeralPlatformStackRepository,
  options: PrepareEphemeralPlatformStackOptions,
): Promise<EphemeralPlatformSetupEvidence> {
  const runId = normalizeRunId(options.runId);
  const machineCode = testbedMachineCode(options.machineCodePrefix, runId);
  const now = options.now ?? new Date();
  const mockPaymentAcknowledged = options.allowMockPayment === true;
  const runtimePaymentMockEnabled = options.runtimePaymentMockEnabled === true;
  const prepareMockPayment =
    mockPaymentAcknowledged && runtimePaymentMockEnabled;
  const prepared = await repository.prepareRun({
    runId,
    machineCode,
    reset: options.reset ?? false,
    now,
    prepareMockPayment,
  });
  const machineApiBase = `/api/machines/${prepared.machine.code}`;
  const paymentReadiness = prepareMockPayment
    ? prepared.payment
    : {
        ready: false,
        mockProviderStatus: "not_prepared" as const,
        serviceRequiresPaymentMockEnabled: true as const,
        runtimePaymentMockEnabled,
        mockPaymentAcknowledged,
      };

  return {
    runId,
    preparedAt: now.toISOString(),
    stack: {
      apiBaseUrl: options.apiBaseUrl,
      mqttUrl: options.mqttUrl,
      databaseTarget: "explicit",
    },
    testbedMachine: {
      id: prepared.machine.id,
      code: prepared.machine.code,
      created: prepared.machine.created,
      claim: {
        claimCode: prepared.claim.claimCode,
        claimCodeId: prepared.claim.id,
        expiresAt: prepared.claim.expiresAt.toISOString(),
        path: "/api/machines/claim",
        closedClaimCodeIds: prepared.claim.closedClaimCodeIds,
      },
    },
    hardwareSlotTopology: prepared.hardwareSlotTopology,
    seededData: {
      products: prepared.products,
      planogram: {
        planogramVersion: prepared.planogram.planogramVersion,
        status: prepared.planogram.status,
        slotCount: prepared.planogram.slotCount,
      },
      stockSetup: prepared.planogram.inventory,
      paymentReadiness,
    },
    verificationPaths: {
      provisioningClaim: "/api/machines/claim",
      machineAuthToken: "/api/machine-auth/token",
      publishedPlanogram: `${machineApiBase}/planogram-versions/published`,
      planogramAck: `${machineApiBase}/planogram-versions/${prepared.planogram.planogramVersion}/ack`,
      stockSnapshot: `${machineApiBase}/stock-snapshot`,
      machineOrders: "/api/machine-orders",
    },
  };
}

export class DrizzleEphemeralPlatformStackRepository implements EphemeralPlatformStackRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly options: {
      machineClaimLookupHmacKey: string;
      claimCodeTtlSeconds: number;
    },
  ) {}

  async prepareRun(input: {
    runId: string;
    machineCode: string;
    reset: boolean;
    now: Date;
    prepareMockPayment: boolean;
  }): Promise<PreparedRunData> {
    return await this.db.transaction(
      async (tx) => {
        const machine = await this.prepareMachine(tx, input);
        const products = await this.prepareProducts(tx, input.runId);
        const planogram = await this.prepareSlotsInventoryAndPlanogram(tx, {
          machineId: machine.id,
          machineCode: machine.code,
          runId: input.runId,
          products,
          now: input.now,
        });
        if (input.prepareMockPayment) {
          await this.prepareMockPaymentProvider(tx, input.now);
        }
        const claim = await this.prepareClaimCode(tx, {
          machineId: machine.id,
          now: input.now,
        });

        return {
          machine,
          claim,
          hardwareSlotTopology: {
            identity: "vem-prod-24",
            version: "2026-06-adr0026",
            slots: TESTBED_SLOTS.map((slot) => ({
              slotCode: slot.slotCode,
              layerNo: slot.layerNo,
              cellNo: slot.cellNo,
              capacity: slot.capacity,
            })),
          },
          products,
          planogram,
          payment: {
            ready: input.prepareMockPayment,
            mockProviderStatus: input.prepareMockPayment
              ? "enabled"
              : "not_prepared",
            serviceRequiresPaymentMockEnabled: true,
            runtimePaymentMockEnabled: input.prepareMockPayment,
            mockPaymentAcknowledged: input.prepareMockPayment,
          },
        };
      },
      { isolationLevel: "serializable" },
    );
  }

  private async prepareMachine(
    tx: DrizzleClient,
    input: {
      machineCode: string;
      now: Date;
      reset: boolean;
    },
  ): Promise<PreparedRunData["machine"]> {
    const [existing] = await tx
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(eq(machines.code, input.machineCode))
      .limit(1)
      .for("update");
    const created = existing === undefined;

    if (existing && input.reset) {
      await this.resetMachineSetup(tx, existing.id);
    }

    const values = {
      code: input.machineCode,
      name: `Machine Runtime Testbed ${input.machineCode.replace(
        /^VEM-TESTBED-/,
        "",
      )}`,
      status: "online" as const,
      secretHash: null,
      secretVersion: 1,
      secretRotatedAt: null,
      credentialRevokedAt: null,
      mqttClientId: `vem-machine-${input.machineCode}`,
      mqttSigningSecretEncryptedJson: null,
      deletedAt: null,
      updatedAt: input.now,
    };

    const [machine] = existing
      ? await tx
          .update(machines)
          .set(values)
          .where(eq(machines.id, existing.id))
          .returning({ id: machines.id, code: machines.code })
      : await tx
          .insert(machines)
          .values({ ...values, createdAt: input.now })
          .returning({ id: machines.id, code: machines.code });

    return { ...machine, created };
  }

  private async resetMachineSetup(
    tx: DrizzleClient,
    machineId: string,
  ): Promise<void> {
    const versions = await tx
      .select({ id: machinePlanogramVersions.id })
      .from(machinePlanogramVersions)
      .where(eq(machinePlanogramVersions.machineId, machineId))
      .for("update");
    const versionIds = versions.map((version) => version.id);
    if (versionIds.length > 0) {
      await tx
        .delete(machinePlanogramSlots)
        .where(
          inArray(machinePlanogramSlots.machinePlanogramVersionId, versionIds),
        );
      await tx
        .delete(machinePlanogramVersions)
        .where(inArray(machinePlanogramVersions.id, versionIds));
    }
    await tx
      .update(machineClaimCodes)
      .set({ state: "revoked", revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(machineClaimCodes.machineId, machineId),
          inArray(machineClaimCodes.state, ["pending", "locked"]),
        ),
      );
  }

  private async prepareProducts(
    tx: DrizzleClient,
    runId: string,
  ): Promise<PreparedRunData["products"]> {
    const result: PreparedRunData["products"] = [];
    for (const [index, slot] of TESTBED_SLOTS.entries()) {
      const sku = `TB-${runId}-${slot.skuSuffix}`;
      const [existingVariant] = await tx
        .select({
          variantId: productVariants.id,
          productId: productVariants.productId,
        })
        .from(productVariants)
        .where(eq(productVariants.sku, sku))
        .limit(1);

      const productId =
        existingVariant?.productId ??
        (
          await tx
            .insert(products)
            .values({
              name: slot.name,
              description: `Ephemeral platform stack fixture for ${runId}`,
              status: "active",
              sortOrder: 9000 + index,
            })
            .returning({ id: products.id })
        )[0].id;

      await tx
        .update(products)
        .set({
          name: slot.name,
          description: `Ephemeral platform stack fixture for ${runId}`,
          status: "active",
          sortOrder: 9000 + index,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(products.id, productId));

      const [variant] = existingVariant
        ? await tx
            .update(productVariants)
            .set({
              productId,
              size: slot.size,
              color: slot.color,
              priceCents: slot.priceCents,
              status: "active",
              deletedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(productVariants.id, existingVariant.variantId))
            .returning({
              id: productVariants.id,
              productId: productVariants.productId,
            })
        : await tx
            .insert(productVariants)
            .values({
              productId,
              sku,
              size: slot.size,
              color: slot.color,
              priceCents: slot.priceCents,
              status: "active",
            })
            .returning({
              id: productVariants.id,
              productId: productVariants.productId,
            });

      result.push({
        productId: variant.productId,
        variantId: variant.id,
        sku,
        name: slot.name,
        priceCents: slot.priceCents,
      });
    }
    return result;
  }

  private async prepareSlotsInventoryAndPlanogram(
    tx: DrizzleClient,
    input: {
      machineId: string;
      machineCode: string;
      runId: string;
      products: PreparedRunData["products"];
      now: Date;
    },
  ): Promise<PreparedRunData["planogram"]> {
    const planogramVersion = `TESTBED-${input.runId}`;
    await tx
      .update(machinePlanogramVersions)
      .set({ status: "retired", updatedAt: input.now })
      .where(
        and(
          eq(machinePlanogramVersions.machineId, input.machineId),
          eq(machinePlanogramVersions.status, "active"),
        ),
      );

    const [version] = await tx
      .insert(machinePlanogramVersions)
      .values({
        machineId: input.machineId,
        planogramVersion,
        status: "published",
        publishedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          machinePlanogramVersions.machineId,
          machinePlanogramVersions.planogramVersion,
        ],
        set: {
          status: "published",
          acknowledgedAt: null,
          activeAt: null,
          updatedAt: input.now,
        },
      })
      .returning({
        id: machinePlanogramVersions.id,
        planogramVersion: machinePlanogramVersions.planogramVersion,
      });
    await tx
      .delete(machinePlanogramSlots)
      .where(eq(machinePlanogramSlots.machinePlanogramVersionId, version.id));

    const inventory: PreparedRunData["planogram"]["inventory"] = [];
    for (const [index, slotSeed] of TESTBED_SLOTS.entries()) {
      const product = input.products[index];
      const [slot] = await tx
        .insert(machineSlots)
        .values({
          machineId: input.machineId,
          layerNo: slotSeed.layerNo,
          cellNo: slotSeed.cellNo,
          slotCode: slotSeed.slotCode,
          capacity: slotSeed.capacity,
          status: "enabled",
        })
        .onConflictDoUpdate({
          target: [
            machineSlots.machineId,
            machineSlots.layerNo,
            machineSlots.cellNo,
          ],
          set: {
            slotCode: slotSeed.slotCode,
            capacity: slotSeed.capacity,
            status: "enabled",
            deletedAt: null,
            updatedAt: input.now,
          },
        })
        .returning({ id: machineSlots.id });

      const [inventoryRow] = await tx
        .insert(inventories)
        .values({
          machineId: input.machineId,
          slotId: slot.id,
          variantId: product.variantId,
          onHandQty: slotSeed.onHandQty,
          reservedQty: 0,
          lowStockThreshold: slotSeed.lowStockThreshold,
        })
        .onConflictDoUpdate({
          target: inventories.slotId,
          set: {
            variantId: product.variantId,
            onHandQty: slotSeed.onHandQty,
            reservedQty: 0,
            lowStockThreshold: slotSeed.lowStockThreshold,
            updatedAt: input.now,
          },
        })
        .returning({ id: inventories.id });

      await tx.insert(machinePlanogramSlots).values({
        machinePlanogramVersionId: version.id,
        slotId: slot.id,
        slotCode: slotSeed.slotCode,
        layerNo: slotSeed.layerNo,
        cellNo: slotSeed.cellNo,
        capacity: slotSeed.capacity,
        parLevel: slotSeed.lowStockThreshold,
        inventoryId: inventoryRow.id,
        variantId: product.variantId,
        productId: product.productId,
        productName: product.name,
        productDescription: `Ephemeral platform stack fixture for ${input.runId}`,
        coverImageUrl: null,
        categoryId: null,
        categoryName: null,
        sku: product.sku,
        size: slotSeed.size,
        color: slotSeed.color,
        priceCents: product.priceCents,
        productSortOrder: index,
        targetGender: null,
      });

      inventory.push({
        slotCode: slotSeed.slotCode,
        inventoryId: inventoryRow.id,
        onHandQty: slotSeed.onHandQty,
        lowStockThreshold: slotSeed.lowStockThreshold,
      });
    }

    return {
      planogramVersion: version.planogramVersion,
      status: "published",
      slotCount: TESTBED_SLOTS.length,
      inventory,
    };
  }

  private async prepareMockPaymentProvider(
    tx: DrizzleClient,
    now: Date,
  ): Promise<void> {
    await tx
      .insert(paymentProviders)
      .values({
        code: "mock",
        name: "Mock 支付",
        type: "mock",
        status: "enabled",
        capabilities: {
          createPaymentIntent: true,
          webhook: true,
          refund: true,
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: paymentProviders.code,
        set: {
          status: "enabled",
          capabilities: {
            createPaymentIntent: true,
            webhook: true,
            refund: true,
          },
          updatedAt: now,
        },
      });
  }

  private async prepareClaimCode(
    tx: DrizzleClient,
    input: {
      machineId: string;
      now: Date;
    },
  ): Promise<PreparedRunData["claim"]> {
    const openClaimCodes = await tx
      .select({ id: machineClaimCodes.id })
      .from(machineClaimCodes)
      .where(
        and(
          eq(machineClaimCodes.machineId, input.machineId),
          inArray(machineClaimCodes.state, ["pending", "locked"]),
        ),
      )
      .for("update");
    const openClaimCodeIds = openClaimCodes.map((claimCode) => claimCode.id);
    if (openClaimCodeIds.length > 0) {
      await tx
        .update(machineClaimCodes)
        .set({
          state: sql`case when ${machineClaimCodes.expiresAt} <= ${input.now} then 'expired'::machine_claim_code_state else 'revoked'::machine_claim_code_state end`,
          revokedAt: sql`case when ${machineClaimCodes.expiresAt} <= ${input.now} then ${machineClaimCodes.revokedAt} else ${input.now} end`,
          updatedAt: input.now,
        })
        .where(inArray(machineClaimCodes.id, openClaimCodeIds));
    }

    const claimCode = generateHumanMachineClaimCode();
    const expiresAt = new Date(
      input.now.getTime() + this.options.claimCodeTtlSeconds * 1_000,
    );
    const [created] = await tx
      .insert(machineClaimCodes)
      .values({
        machineId: input.machineId,
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
      id: created.id,
      claimCode,
      expiresAt,
      closedClaimCodeIds: openClaimCodeIds,
    };
  }
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  const db = new DrizzleDB(options.databaseUrl);
  await db.connect();
  try {
    const repository = new DrizzleEphemeralPlatformStackRepository(db.client, {
      machineClaimLookupHmacKey: options.machineClaimLookupHmacKey,
      claimCodeTtlSeconds: options.claimCodeTtlSeconds,
    });
    const evidence = await prepareEphemeralPlatformStack(repository, options);
    const json = `${JSON.stringify(evidence, null, 2)}\n`;
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
