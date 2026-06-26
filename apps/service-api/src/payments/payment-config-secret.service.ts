import { Inject, Injectable } from "@nestjs/common";
import { createHash, X509Certificate } from "node:crypto";

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
