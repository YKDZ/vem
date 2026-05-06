import type { DrizzleClient } from "@vem/db";

import { UnauthorizedException } from "@nestjs/common";
import { mqttSigningInput } from "@vem/shared";
import { describe, expect, it } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import {
  type EncryptedCredentialJson,
  encryptCredentialSecret,
  generateMachineSecret,
  hmacSha256Base64Url,
} from "../machine-auth/machine-credentials.util";
import { MqttSignatureService } from "./mqtt-signature.service";

const MQTT_SIGNING_SECRET = generateMachineSecret();
const ENCRYPTION_KEY = "local-cred-enc-key-change-before-production!";
const ENCRYPTED_JSON = encryptCredentialSecret(
  MQTT_SIGNING_SECRET,
  ENCRYPTION_KEY,
);

const MOCK_MACHINE = {
  id: "00000000-0000-0000-0000-000000000001",
  code: "M001",
  status: "online" as const,
  credentialRevokedAt: null as Date | null,
  mqttSigningSecretEncryptedJson:
    ENCRYPTED_JSON as EncryptedCredentialJson | null,
};

function createService(overrides?: {
  dbResult?: typeof MOCK_MACHINE | null;
  toleranceSeconds?: number;
}) {
  const dbResult =
    overrides && "dbResult" in overrides ? overrides.dbResult : MOCK_MACHINE;
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => Promise.resolve(dbResult ? [dbResult] : []),
        }),
      }),
    }),
  } as unknown as DrizzleClient;

  const mockConfig = {
    machineCredentialEncryptionKey: ENCRYPTION_KEY,
    mqttSignatureToleranceSeconds: overrides?.toleranceSeconds ?? 300,
  } as unknown as AppConfigService;

  const credentialService = new MachineCredentialService(mockConfig);
  return new MqttSignatureService(mockDb, mockConfig, credentialService);
}

function buildValidEnvelope(overrides?: {
  machineCode?: string;
  issuedAt?: string;
  signature?: string;
}) {
  const machineCode = overrides?.machineCode ?? "M001";
  const payload = { commandNo: "CMD1" };
  const issuedAt = overrides?.issuedAt ?? new Date().toISOString();
  const nonce = "nonce-1234567890abcdef";
  const messageId = "msg-001";

  const envelopeWithoutSig = {
    messageId,
    machineCode,
    issuedAt,
    nonce,
    payload,
  };
  const signature =
    overrides?.signature ??
    hmacSha256Base64Url(
      MQTT_SIGNING_SECRET,
      mqttSigningInput(envelopeWithoutSig),
    );

  return { ...envelopeWithoutSig, signature };
}

describe("MqttSignatureService", () => {
  describe("signForMachine", () => {
    it("produces a valid signed envelope", async () => {
      const service = createService();
      const envelope = await service.signForMachine({
        machineCode: "M001",
        payload: { commandNo: "CMD1" },
        messageId: "msg-001",
      });
      expect(envelope.machineCode).toBe("M001");
      expect(envelope.signature).toBeDefined();
      expect(envelope.signature.length).toBeGreaterThan(32);
    });

    it("throws when machine has no mqtt signing secret", async () => {
      const service = createService({
        dbResult: { ...MOCK_MACHINE, mqttSigningSecretEncryptedJson: null },
      });
      await expect(
        service.signForMachine({
          machineCode: "M001",
          payload: {},
          messageId: "m",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("verifyFromTopic", () => {
    it("accepts a valid signed envelope", async () => {
      const { z } = await import("zod");
      const schema = z.object({ commandNo: z.string() });
      const service = createService();
      const envelope = buildValidEnvelope();

      const result = await service.verifyFromTopic({
        topicMachineCode: "M001",
        rawPayload: envelope,
        payloadSchema: schema,
      });
      expect(result.machineCode).toBe("M001");
      expect(result.payload.commandNo).toBe("CMD1");
    });

    it("rejects when topic machineCode mismatches envelope machineCode", async () => {
      const { z } = await import("zod");
      const schema = z.object({ commandNo: z.string() });
      const service = createService();
      const envelope = buildValidEnvelope({ machineCode: "M001" });

      await expect(
        service.verifyFromTopic({
          topicMachineCode: "M002",
          rawPayload: envelope,
          payloadSchema: schema,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an expired issuedAt (outside time window)", async () => {
      const { z } = await import("zod");
      const schema = z.object({ commandNo: z.string() });
      const service = createService({ toleranceSeconds: 60 });
      const oldIssuedAt = new Date(Date.now() - 120_000).toISOString();
      const envelope = buildValidEnvelope({ issuedAt: oldIssuedAt });

      await expect(
        service.verifyFromTopic({
          topicMachineCode: "M001",
          rawPayload: envelope,
          payloadSchema: schema,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an invalid signature", async () => {
      const { z } = await import("zod");
      const schema = z.object({ commandNo: z.string() });
      const service = createService();
      const envelope = buildValidEnvelope({ signature: "a".repeat(44) });

      await expect(
        service.verifyFromTopic({
          topicMachineCode: "M001",
          rawPayload: envelope,
          payloadSchema: schema,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a revoked machine", async () => {
      const { z } = await import("zod");
      const schema = z.object({ commandNo: z.string() });
      const service = createService({
        dbResult: { ...MOCK_MACHINE, credentialRevokedAt: new Date() },
      });
      const envelope = buildValidEnvelope();

      await expect(
        service.verifyFromTopic({
          topicMachineCode: "M001",
          rawPayload: envelope,
          payloadSchema: schema,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
