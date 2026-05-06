import { mqttSigningInput } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { signMqttEnvelope, verifyMqttEnvelope } from "./signature";

const TEST_SECRET = "vms_test_signing_secret_12345678901234567890";

describe("signMqttEnvelope", () => {
  it("produces a signed envelope with all required fields", async () => {
    const envelope = await signMqttEnvelope({
      machineCode: "M001",
      payload: { commandNo: "CMD1" },
      messageId: "msg-001",
      signingSecret: TEST_SECRET,
    });

    expect(envelope.machineCode).toBe("M001");
    expect(envelope.messageId).toBe("msg-001");
    expect(envelope.signature).toBeDefined();
    expect(envelope.signature.length).toBeGreaterThan(32);
    expect(envelope.nonce.length).toBeGreaterThanOrEqual(16);
  });

  it("produces different nonces for repeated calls", async () => {
    const [a, b] = await Promise.all([
      signMqttEnvelope({
        machineCode: "M001",
        payload: {},
        messageId: "m1",
        signingSecret: TEST_SECRET,
      }),
      signMqttEnvelope({
        machineCode: "M001",
        payload: {},
        messageId: "m2",
        signingSecret: TEST_SECRET,
      }),
    ]);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("verifyMqttEnvelope", () => {
  it("verifies a self-signed envelope", async () => {
    const envelope = await signMqttEnvelope({
      machineCode: "M001",
      payload: { commandNo: "CMD1" },
      messageId: "msg-001",
      signingSecret: TEST_SECRET,
    });

    const result = await verifyMqttEnvelope({
      envelope,
      signingSecret: TEST_SECRET,
    });
    expect(result.machineCode).toBe("M001");
  });

  it("throws on tampered signature", async () => {
    const envelope = await signMqttEnvelope({
      machineCode: "M001",
      payload: { commandNo: "CMD1" },
      messageId: "msg-001",
      signingSecret: TEST_SECRET,
    });

    await expect(
      verifyMqttEnvelope({
        envelope: { ...envelope, signature: "a".repeat(44) },
        signingSecret: TEST_SECRET,
      }),
    ).rejects.toThrow("Invalid envelope signature");
  });

  it("throws on wrong signing secret", async () => {
    const envelope = await signMqttEnvelope({
      machineCode: "M001",
      payload: {},
      messageId: "m",
      signingSecret: TEST_SECRET,
    });

    await expect(
      verifyMqttEnvelope({
        envelope,
        signingSecret: "wrong-secret-0000000000000000000",
      }),
    ).rejects.toThrow("Invalid envelope signature");
  });

  it("throws when envelope is too old", async () => {
    const oldIssuedAt = new Date(Date.now() - 400_000).toISOString();
    const nonce = "nonce-1234567890abcdef";
    const messageId = "msg-old";
    const machineCode = "M001";
    const payload = {};
    const envelopeWithoutSig = {
      messageId,
      machineCode,
      issuedAt: oldIssuedAt,
      nonce,
      payload,
    };
    // We need to import hmacSha256Base64Url for node test context — use node crypto
    const { createHmac } = await import("node:crypto");
    const signingInput = mqttSigningInput(envelopeWithoutSig);
    const sig = createHmac("sha256", TEST_SECRET)
      .update(signingInput)
      .digest("base64url");

    await expect(
      verifyMqttEnvelope({
        envelope: { ...envelopeWithoutSig, signature: sig },
        signingSecret: TEST_SECRET,
        toleranceSeconds: 300,
      }),
    ).rejects.toThrow("outside time window");
  });

  it("throws on missing required fields", async () => {
    await expect(
      verifyMqttEnvelope({
        envelope: { machineCode: "M001" },
        signingSecret: TEST_SECRET,
      }),
    ).rejects.toThrow("missing required fields");
  });
});
