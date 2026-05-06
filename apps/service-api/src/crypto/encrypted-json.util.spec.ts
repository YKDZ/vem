import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "./encrypted-json.util";

const KEY = "test-encryption-key-must-be-32-chars-long";

describe("encrypted-json.util", () => {
  it("encrypts and decrypts JSON correctly", () => {
    const original = { apiKey: "secret-value", amount: 100, active: true };
    const encrypted = encryptJson(original, KEY);
    const decrypted = decryptJson(encrypted, KEY);
    expect(decrypted).toEqual(original);
  });

  it("encrypted ciphertext does not contain plaintext values", () => {
    const original = { apiKey: "my-secret-key", password: "hunter2" };
    const encrypted = encryptJson(original, KEY);
    const serialized = JSON.stringify(encrypted);
    expect(serialized).not.toContain("my-secret-key");
    expect(serialized).not.toContain("hunter2");
  });

  it("decryption with wrong key throws", () => {
    const original = { secret: "value" };
    const encrypted = encryptJson(original, KEY);
    expect(() =>
      decryptJson(encrypted, "wrong-key-that-is-also-32-chars-x"),
    ).toThrow();
  });

  it("rejects unsupported format", () => {
    const invalid = {
      v: 2 as 1,
      alg: "aes-256-gcm" as const,
      iv: "a",
      tag: "b",
      ciphertext: "c",
    };
    expect(() => decryptJson(invalid, KEY)).toThrow(
      "Unsupported encrypted JSON format",
    );
  });

  it("two encryptions of the same value produce different ciphertexts", () => {
    const original = { key: "value" };
    const enc1 = encryptJson(original, KEY);
    const enc2 = encryptJson(original, KEY);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(decryptJson(enc1, KEY)).toEqual(original);
    expect(decryptJson(enc2, KEY)).toEqual(original);
  });
});
