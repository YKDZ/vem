import { describe, expect, it } from "vitest";

import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  generateMachineSecret,
  hashMachineSecret,
  hmacSha256Base64Url,
  safeEqualText,
  verifyMachineSecret,
} from "./machine-credentials.util";

describe("generateMachineSecret", () => {
  it("starts with vms_ prefix", () => {
    const secret = generateMachineSecret();
    expect(secret.startsWith("vms_")).toBe(true);
  });

  it("has length greater than 32", () => {
    const secret = generateMachineSecret();
    expect(secret.length).toBeGreaterThan(32);
  });

  it("generates unique secrets each time", () => {
    const secret1 = generateMachineSecret();
    const secret2 = generateMachineSecret();
    expect(secret1).not.toBe(secret2);
  });
});

describe("hashMachineSecret / verifyMachineSecret", () => {
  it("correctly verifies a valid secret", () => {
    const secret = generateMachineSecret();
    const hash = hashMachineSecret(secret);
    expect(verifyMachineSecret(secret, hash)).toBe(true);
  });

  it("rejects an incorrect secret", () => {
    const secret = generateMachineSecret();
    const hash = hashMachineSecret(secret);
    expect(verifyMachineSecret("vms_wrong_secret_value", hash)).toBe(false);
  });

  it("rejects a malformed hash", () => {
    expect(verifyMachineSecret("vms_secret", "malformed")).toBe(false);
  });

  it("rejects empty hash", () => {
    expect(verifyMachineSecret("vms_secret", "")).toBe(false);
  });
});

describe("encryptCredentialSecret / decryptCredentialSecret", () => {
  const keyMaterial = "test-encryption-key-material-32chars!";

  it("encrypted JSON does not contain plaintext", () => {
    const secret = "vms_super_secret_mqtt_signing_key";
    const encrypted = encryptCredentialSecret(secret, keyMaterial);
    const json = JSON.stringify(encrypted);
    expect(json).not.toContain(secret);
  });

  it("decrypts to original value", () => {
    const secret = "vms_super_secret_mqtt_signing_key";
    const encrypted = encryptCredentialSecret(secret, keyMaterial);
    const decrypted = decryptCredentialSecret(encrypted, keyMaterial);
    expect(decrypted).toBe(secret);
  });

  it("produces different ciphertexts for same secret (random IV)", () => {
    const secret = "vms_test_secret";
    const enc1 = encryptCredentialSecret(secret, keyMaterial);
    const enc2 = encryptCredentialSecret(secret, keyMaterial);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it("throws on unsupported format version", () => {
    const secret = "vms_test";
    const encrypted = encryptCredentialSecret(secret, keyMaterial);
    expect(() =>
      decryptCredentialSecret({ ...encrypted, v: 99 as 1 }, keyMaterial),
    ).toThrow("Unsupported encrypted credential format");
  });
});

describe("hmacSha256Base64Url", () => {
  it("produces stable output for same inputs", () => {
    const result1 = hmacSha256Base64Url("secret", "value");
    const result2 = hmacSha256Base64Url("secret", "value");
    expect(result1).toBe(result2);
  });

  it("produces different output for different inputs", () => {
    const result1 = hmacSha256Base64Url("secret", "value1");
    const result2 = hmacSha256Base64Url("secret", "value2");
    expect(result1).not.toBe(result2);
  });
});

describe("safeEqualText", () => {
  it("returns true for equal strings", () => {
    expect(safeEqualText("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeEqualText("hello", "world")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(safeEqualText("short", "much-longer-string")).toBe(false);
  });
});
