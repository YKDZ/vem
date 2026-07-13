import { Inject, Injectable } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  generateMachineSecret,
  hashMachineSecret,
  isEncryptedCredentialJson,
  type EncryptedCredentialJson,
  verifyMachineSecret,
} from "./machine-credentials.util";

export type MachineCredentialBundle = {
  machineSecret: string;
  mqttSigningSecret: string;
  secretHash: string;
  mqttSigningSecretEncryptedJson: EncryptedCredentialJson;
};

@Injectable()
export class MachineCredentialService {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  createBundle(): MachineCredentialBundle {
    const machineSecret = generateMachineSecret();
    const mqttSigningSecret = generateMachineSecret();
    return {
      machineSecret,
      mqttSigningSecret,
      secretHash: hashMachineSecret(machineSecret),
      mqttSigningSecretEncryptedJson: encryptCredentialSecret(
        mqttSigningSecret,
        this.config.machineCredentialEncryptionKey,
      ),
    };
  }

  verifyMachineSecret(actualSecret: string, storedHash: string): boolean {
    return verifyMachineSecret(actualSecret, storedHash);
  }

  decryptMqttSigningSecret(encrypted: EncryptedCredentialJson): string {
    return decryptCredentialSecret(
      encrypted,
      this.config.machineCredentialEncryptionKey,
    );
  }

  encryptClaimResponse(value: unknown): EncryptedCredentialJson {
    return encryptCredentialSecret(
      JSON.stringify(value),
      this.config.machineCredentialEncryptionKey,
    );
  }

  decryptClaimResponse(value: unknown): unknown {
    if (!isEncryptedCredentialJson(value)) {
      throw new Error("Invalid encrypted claim response");
    }
    return JSON.parse(
      decryptCredentialSecret(
        value,
        this.config.machineCredentialEncryptionKey,
      ),
    );
  }
}
