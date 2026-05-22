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

  it("summarize includes sha256 fingerprint without plaintext", () => {
    const service = makeSecretService();
    const summary = service.summarize(
      { apiV3Key: "super-secret-value" },
      "2026-05-06T00:00:00.000Z",
    );
    expect(summary["apiV3Key"]?.configured).toBe(true);
    expect(summary["apiV3Key"]?.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("super-secret-value");
  });

  it("summarize extracts certificate expiration for PEM certificates", () => {
    const service = makeSecretService();
    const TEST_CERTIFICATE_PEM = [
      "-----BEGIN CERTIFICATE-----",
      "MIICGjCCAYOgAwIBAgIUUUroCd7Tcfhw8LiUotQwSuGaQkYwDQYJKoZIhvcNAQEL",
      "BQAwHzEdMBsGA1UEAwwUVkVNIFRlc3QgQ2VydGlmaWNhdGUwHhcNMjYwNTA2MDUw",
      "MzIwWhcNMjcwNTA2MDUwMzIwWjAfMR0wGwYDVQQDDBRWRU0gVGVzdCBDZXJ0aWZp",
      "Y2F0ZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA2GWhrrFq7TCKMHSzlNt4",
      "8RP76RC0gRiVB5SgdDBJpQFT/ijn274zc5FpAkMBpa1weXeMQnzfu3AmBtpd8Ngu",
      "T6YrEY7LXkG+d9CukcidcEoTd3qdEig4aQr0CjupDFN7hAPWT4fxLQpikBr/4HeV",
      "IpYCVJsldn8ft4F18qJQMzMCAwEAAaNTMFEwHQYDVR0OBBYEFLrM+UtsnitLTiFZ",
      "k8shSRTFOJDaMB8GA1UdIwQYMBaAFLrM+UtsnitLTiFZk8shSRTFOJDaMA8GA1Ud",
      "EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEACrb5ti4ca2y0t+CqcbRJ2hkt",
      "Q6IgvaB8o//IgXh1OiARj77yDlIpjbGNPbizPdHazsoNxgAkrM0ZXF0QBYRTasXD",
      "MBSg5izad5GrLVcOOJJFkyOdLWRrOkoEiD3EdVqbryxYAkVfCthk0IJde+uGl2kK",
      "fle74W8/qV53VzGPjlI=",
      "-----END CERTIFICATE-----",
    ].join("\n");
    const summary = service.summarize(
      { appCertPem: TEST_CERTIFICATE_PEM },
      new Date("2026-05-06T00:00:00.000Z"),
    );
    expect(summary["appCertPem"]?.certificateExpiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("summarize marks invalid certificate text with errorCode but still hides value", () => {
    const service = makeSecretService();
    const summary = service.summarize(
      {
        appCertPem:
          "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
      },
      null,
    );
    expect(summary["appCertPem"]?.errorCode).toBe("certificate_parse_failed");
    expect(JSON.stringify(summary)).not.toContain("invalid");
  });
});
