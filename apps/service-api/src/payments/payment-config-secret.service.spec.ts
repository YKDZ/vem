import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "../crypto/encrypted-json.util";
import { PaymentConfigSecretService } from "./payment-config-secret.service";

const KEY = "test-encryption-key-32-chars-00x";

function makeSecretService(): PaymentConfigSecretService {
  return new PaymentConfigSecretService({
    paymentConfigEncryptionKey: KEY,
  } as never);
}

describe("PaymentConfigSecretService", () => {
  it("encrypts and decrypts sensitive config", () => {
    const service = makeSecretService();
    const input = { apiV3Key: "abc123", privateKeyPem: "-----BEGIN RSA..." };
    const encrypted = service.encrypt(input);
    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toEqual(input);
  });

  it("encrypted output does not contain plaintext", () => {
    const service = makeSecretService();
    const input = { apiV3Key: "super-secret-value" };
    const encrypted = service.encrypt(input);
    const serialized = JSON.stringify(encrypted);
    expect(serialized).not.toContain("super-secret-value");
  });

  it("summarize returns configured status for each key", () => {
    const service = makeSecretService();
    const keys = { apiV3Key: "secret1", privateKeyPem: "secret2" };
    const updatedAt = new Date("2024-01-01T00:00:00.000Z");
    const summary = service.summarize(keys, updatedAt);
    expect(summary["apiV3Key"]?.configured).toBe(true);
    expect(summary["privateKeyPem"]?.configured).toBe(true);
    expect(summary["apiV3Key"]?.updatedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("summarize returns empty object for null input", () => {
    const service = makeSecretService();
    const summary = service.summarize(null, null);
    expect(summary).toEqual({});
  });

  it("encrypt/decrypt is consistent with raw util", () => {
    const service = makeSecretService();
    const input = { token: "xyz" };
    const encrypted = service.encrypt(input);
    const decryptedDirect = decryptJson(encrypted, KEY);
    expect(decryptedDirect).toEqual(input);

    const encryptedDirect = encryptJson(input, KEY);
    const decrypted = service.decrypt(encryptedDirect);
    expect(decrypted).toEqual(input);
  });
});
