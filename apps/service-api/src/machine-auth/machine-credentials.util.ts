import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export type EncryptedCredentialJson = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function isEncryptedCredentialJson(
  v: unknown,
): v is EncryptedCredentialJson {
  return (
    typeof v === "object" &&
    v !== null &&
    Reflect.get(v, "v") === 1 &&
    Reflect.get(v, "alg") === "aes-256-gcm" &&
    typeof Reflect.get(v, "iv") === "string" &&
    typeof Reflect.get(v, "tag") === "string" &&
    typeof Reflect.get(v, "ciphertext") === "string"
  );
}

const SCRYPT_KEY_LENGTH = 32;
const MACHINE_SECRET_PREFIX = "vms_";

export function generateMachineSecret(): string {
  return `${MACHINE_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashMachineSecret(secret: string): string {
  const salt = randomBytes(16).toString("base64url");
  const digest = scryptSync(secret, salt, SCRYPT_KEY_LENGTH).toString(
    "base64url",
  );
  return `scrypt:${salt}:${digest}`;
}

export function verifyMachineSecret(
  actualSecret: string,
  storedHash: string,
): boolean {
  const [algorithm, salt, expectedDigest] = storedHash.split(":");
  if (algorithm !== "scrypt" || !salt || !expectedDigest) return false;
  const actual = Buffer.from(
    scryptSync(actualSecret, salt, SCRYPT_KEY_LENGTH).toString("base64url"),
  );
  const expected = Buffer.from(expectedDigest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encryptionKey(keyMaterial: string): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}

export function encryptCredentialSecret(
  secret: string,
  keyMaterial: string,
): EncryptedCredentialJson {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptCredentialSecret(
  encrypted: EncryptedCredentialJson,
  keyMaterial: string,
): string {
  if (encrypted.v !== 1 || encrypted.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted credential format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyMaterial),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hmacSha256Base64Url(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
