import { Inject, Injectable } from "@nestjs/common";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";

import { AppConfigService } from "../config/app-config.service";
import {
  decryptJson,
  encryptJson,
  type EncryptedJson,
} from "../crypto/encrypted-json.util";

export type PaymentSecretStatus = {
  configured: boolean;
  updatedAt: string | null;
  fingerprintSha256?: string | null;
  certificateExpiresAt?: string | null;
  errorCode?: string | null;
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function certificateExpiresAt(value: string): string | null {
  if (!value.includes("BEGIN CERTIFICATE")) return null;
  const matches = value.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  const expiresAtValues = (matches ?? [value]).map((pem) =>
    new Date(new X509Certificate(pem).validTo).toISOString(),
  );
  return expiresAtValues.sort()[0] ?? null;
}

const alipayCertificateKeys = [
  "appCertPem",
  "alipayPublicCertPem",
  "alipayRootCertPem",
] as const;

function isPem(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]+-----/.test(value);
}

function toPem(value: string, label: string): string {
  const trimmed = value.trim().replace(/\r\n/g, "\n");
  if (isPem(trimmed)) return `${trimmed}\n`;
  const body = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    return trimmed;
  }
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

@Injectable()
export class PaymentConfigSecretService {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  encrypt(input: Record<string, unknown>): EncryptedJson {
    return encryptJson(input, this.config.paymentConfigEncryptionKey);
  }

  decrypt(input: EncryptedJson): Record<string, unknown> {
    return decryptJson(input, this.config.paymentConfigEncryptionKey);
  }

  normalizeAlipaySensitiveConfig(
    input: Record<string, unknown>,
    keyType: "PKCS8" | "PKCS1",
  ): Record<string, unknown> {
    const normalized = { ...input };
    const privateKey = normalized["privateKeyPem"];
    if (typeof privateKey === "string" && privateKey.trim().length > 0) {
      normalized["privateKeyPem"] = toPem(
        privateKey,
        keyType === "PKCS1" ? "RSA PRIVATE KEY" : "PRIVATE KEY",
      );
    }
    for (const key of alipayCertificateKeys) {
      const value = normalized[key];
      if (typeof value === "string" && value.trim().length > 0) {
        normalized[key] = toPem(value, "CERTIFICATE");
      }
    }
    return normalized;
  }

  assertAlipaySensitiveConfigParseable(input: Record<string, unknown>): void {
    const invalid: string[] = [];
    const privateKey = input["privateKeyPem"];
    if (typeof privateKey === "string" && privateKey.trim().length > 0) {
      try {
        createPrivateKey(privateKey);
      } catch {
        invalid.push("privateKeyPem");
      }
    }
    for (const key of alipayCertificateKeys) {
      const value = input[key];
      if (typeof value !== "string" || value.trim().length === 0) continue;
      try {
        const certificates = value.match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        );
        if (!certificates?.length) throw new Error("missing certificate");
        certificates.forEach((certificate) => new X509Certificate(certificate));
      } catch {
        invalid.push(key);
      }
    }
    if (invalid.length > 0) {
      throw new Error(`invalid Alipay sensitive config: ${invalid.join(", ")}`);
    }
  }

  summarize(
    input: Record<string, unknown> | null,
    updatedAt: Date | string | null,
  ): Record<string, PaymentSecretStatus> {
    if (!input) return {};
    const updatedAtText =
      updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
    return Object.fromEntries<PaymentSecretStatus>(
      Object.entries(input).map(([key, value]) => {
        if (typeof value !== "string" || value.length === 0) {
          return [key, { configured: false, updatedAt: updatedAtText }];
        }
        try {
          return [
            key,
            {
              configured: true,
              updatedAt: updatedAtText,
              fingerprintSha256: fingerprint(value),
              certificateExpiresAt: certificateExpiresAt(value),
            },
          ];
        } catch (error) {
          return [
            key,
            {
              configured: true,
              updatedAt: updatedAtText,
              fingerprintSha256: fingerprint(value),
              certificateExpiresAt: null,
              errorCode:
                error instanceof Error
                  ? "certificate_parse_failed"
                  : "unknown_error",
            },
          ];
        }
      }),
    );
  }
}
