import { Injectable } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import {
  decryptJson,
  encryptJson,
  type EncryptedJson,
} from "../crypto/encrypted-json.util";

@Injectable()
export class PaymentConfigSecretService {
  constructor(private readonly config: AppConfigService) {}

  encrypt(input: Record<string, unknown>): EncryptedJson {
    return encryptJson(input, this.config.paymentConfigEncryptionKey);
  }

  decrypt(input: EncryptedJson): Record<string, unknown> {
    return decryptJson(input, this.config.paymentConfigEncryptionKey);
  }

  summarize(
    input: Record<string, unknown> | null,
    updatedAt: Date | string | null,
  ): Record<string, { configured: boolean; updatedAt: string | null }> {
    if (!input) return {};
    const updatedAtText =
      updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
    return Object.fromEntries(
      Object.keys(input).map((key) => [
        key,
        { configured: true, updatedAt: updatedAtText },
      ]),
    );
  }
}
