import { createHmac, randomBytes } from "node:crypto";

import {
  hashMachineSecret,
  verifyMachineSecret,
} from "../machine-auth/machine-credentials.util";

const CLAIM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CLAIM_CODE_LENGTH = 8;

export function generateHumanMachineClaimCode(): string {
  const bytes = randomBytes(CLAIM_CODE_LENGTH);
  const chars = Array.from(bytes, (byte) =>
    CLAIM_CODE_ALPHABET.charAt(byte % CLAIM_CODE_ALPHABET.length),
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function digestMachineClaimCodeLookup(
  claimCode: string,
  hmacKey: string,
): string {
  return createHmac("sha256", hmacKey)
    .update(claimCode.trim().toUpperCase())
    .digest("hex");
}

export function hashMachineClaimCodeVerifier(claimCode: string): string {
  return hashMachineSecret(claimCode);
}

export function verifyMachineClaimCode(
  claimCode: string,
  verifierHash: string,
): boolean {
  return verifyMachineSecret(claimCode, verifierHash);
}
