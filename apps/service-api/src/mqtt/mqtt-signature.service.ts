import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull, machines, type DrizzleClient } from "@vem/db";
import {
  mqttSignedEnvelopeSchema,
  mqttSigningInput,
  type MqttSignedEnvelope,
} from "@vem/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import {
  hmacSha256Base64Url,
  isEncryptedCredentialJson,
  safeEqualText,
} from "../machine-auth/machine-credentials.util";

@Injectable()
export class MqttSignatureService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
    @Inject(MachineCredentialService)
    private readonly machineCredentialService: MachineCredentialService,
  ) {}

  async signForMachine(input: {
    machineCode: string;
    payload: unknown;
    messageId: string;
  }): Promise<MqttSignedEnvelope> {
    const secret = await this.getMqttSigningSecret(input.machineCode);
    return this.signWithSecret(input, secret);
  }

  signSecureDecommissionCommandWithEncryptedCredential(
    machineCode: string,
    payload: {
      commandNo: string;
      operation: "secure-decommission";
      requestedAt: string;
    },
    encryptedCredential: unknown,
  ): MqttSignedEnvelope {
    return this.signCleanupMessageWithEncryptedCredential(
      {
        machineCode,
        messageId: `secure-decommission:${payload.commandNo}`,
        payload,
      },
      encryptedCredential,
    );
  }

  signSecureDecommissionAcknowledgementWithEncryptedCredential(
    machineCode: string,
    payload: {
      commandNo: string;
      operation: "secure-decommission-ack";
      acknowledgedAt: string;
    },
    encryptedCredential: unknown,
  ): MqttSignedEnvelope {
    return this.signCleanupMessageWithEncryptedCredential(
      {
        machineCode,
        messageId: `secure-decommission-ack:${payload.commandNo}`,
        payload,
      },
      encryptedCredential,
    );
  }

  signSecureDecommissionResultWithEncryptedCredential(
    machineCode: string,
    payload: {
      commandNo: string;
      success: boolean;
      reportedAt: string;
      error: string | null;
    },
    encryptedCredential: unknown,
  ): MqttSignedEnvelope {
    return this.signCleanupMessageWithEncryptedCredential(
      {
        machineCode,
        messageId: `secure-decommission-result:${payload.commandNo}`,
        payload,
      },
      encryptedCredential,
    );
  }

  verifySecureDecommissionResultWithEncryptedCredential<TPayload>(input: {
    topicMachineCode: string;
    rawPayload: unknown;
    payloadSchema: z.ZodType<TPayload>;
    encryptedCredential: unknown;
  }): {
    machineCode: string;
    messageId: string;
    payload: TPayload;
  } {
    const envelope = mqttSignedEnvelopeSchema.parse(input.rawPayload);
    if (envelope.machineCode !== input.topicMachineCode) {
      throw new UnauthorizedException("MQTT machine code mismatch");
    }
    this.assertIssuedAtInWindow(envelope.issuedAt);
    if (!isEncryptedCredentialJson(input.encryptedCredential)) {
      throw new UnauthorizedException(
        "Machine MQTT credential is missing or invalid",
      );
    }
    const secret = this.machineCredentialService.decryptMqttSigningSecret(
      input.encryptedCredential,
    );
    this.assertEnvelopeSignature(envelope, secret);
    return {
      machineCode: envelope.machineCode,
      messageId: envelope.messageId,
      payload: input.payloadSchema.parse(envelope.payload),
    };
  }

  private signCleanupMessageWithEncryptedCredential(
    input: {
      machineCode: string;
      payload: unknown;
      messageId: string;
    },
    encryptedCredential: unknown,
  ): MqttSignedEnvelope {
    if (!isEncryptedCredentialJson(encryptedCredential)) {
      throw new UnauthorizedException(
        "Machine MQTT credential is missing or invalid",
      );
    }
    return this.signWithSecret(
      input,
      this.machineCredentialService.decryptMqttSigningSecret(
        encryptedCredential,
      ),
    );
  }

  private signWithSecret(
    input: { machineCode: string; payload: unknown; messageId: string },
    secret: string,
  ): MqttSignedEnvelope {
    const envelopeWithoutSignature = {
      messageId: input.messageId,
      machineCode: input.machineCode,
      issuedAt: new Date().toISOString(),
      nonce: randomUUID(),
      payload: input.payload,
    } satisfies Omit<MqttSignedEnvelope, "signature">;
    return {
      ...envelopeWithoutSignature,
      signature: hmacSha256Base64Url(
        secret,
        mqttSigningInput(envelopeWithoutSignature),
      ),
    };
  }

  async verifyFromTopic<TPayload>(input: {
    topicMachineCode: string;
    rawPayload: unknown;
    payloadSchema: z.ZodType<TPayload>;
  }): Promise<{
    machineId: string;
    machineCode: string;
    messageId: string;
    payload: TPayload;
  }> {
    const envelope = mqttSignedEnvelopeSchema.parse(input.rawPayload);
    if (envelope.machineCode !== input.topicMachineCode) {
      throw new UnauthorizedException("MQTT machine code mismatch");
    }
    this.assertIssuedAtInWindow(envelope.issuedAt);
    const secret = await this.getMqttSigningSecret(envelope.machineCode);
    this.assertEnvelopeSignature(envelope, secret);
    const machine = await this.findMachine(envelope.machineCode);
    return {
      machineId: machine.id,
      machineCode: machine.code,
      messageId: envelope.messageId,
      payload: input.payloadSchema.parse(envelope.payload),
    };
  }

  private assertIssuedAtInWindow(issuedAt: string): void {
    const issuedAtMs = Date.parse(issuedAt);
    const skewMs = Math.abs(Date.now() - issuedAtMs);
    if (
      !Number.isFinite(issuedAtMs) ||
      skewMs > this.config.mqttSignatureToleranceSeconds * 1_000
    ) {
      throw new UnauthorizedException("MQTT message is outside time window");
    }
  }

  private assertEnvelopeSignature(
    envelope: MqttSignedEnvelope,
    secret: string,
  ): void {
    const expectedSignature = hmacSha256Base64Url(
      secret,
      mqttSigningInput({
        messageId: envelope.messageId,
        machineCode: envelope.machineCode,
        issuedAt: envelope.issuedAt,
        nonce: envelope.nonce,
        payload: envelope.payload,
      }),
    );
    if (!safeEqualText(envelope.signature, expectedSignature)) {
      throw new UnauthorizedException("Invalid MQTT signature");
    }
  }

  private async getMqttSigningSecret(machineCode: string): Promise<string> {
    const machine = await this.findMachine(machineCode);
    if (!isEncryptedCredentialJson(machine.mqttSigningSecretEncryptedJson)) {
      throw new UnauthorizedException(
        "Machine MQTT credential is missing or invalid",
      );
    }
    return this.machineCredentialService.decryptMqttSigningSecret(
      machine.mqttSigningSecretEncryptedJson,
    );
  }

  private async findMachine(machineCode: string): Promise<{
    id: string;
    code: string;
    status: "online" | "offline" | "maintenance" | "disabled";
    credentialRevokedAt: Date | null;
    mqttSigningSecretEncryptedJson: unknown;
  }> {
    const [machine] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        status: machines.status,
        credentialRevokedAt: machines.credentialRevokedAt,
        mqttSigningSecretEncryptedJson: machines.mqttSigningSecretEncryptedJson,
      })
      .from(machines)
      .where(and(eq(machines.code, machineCode), isNull(machines.deletedAt)))
      .limit(1);
    if (
      !machine ||
      machine.status === "disabled" ||
      machine.credentialRevokedAt
    ) {
      throw new UnauthorizedException("Invalid MQTT machine credential");
    }
    return machine;
  }
}
