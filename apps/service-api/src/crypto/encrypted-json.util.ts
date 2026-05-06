import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type EncryptedJson = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

function keyFromMaterial(keyMaterial: string): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}

export function encryptJson(
  value: Record<string, unknown>,
  keyMaterial: string,
): EncryptedJson {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyFromMaterial(keyMaterial),
    iv,
  );
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptJson(
  encrypted: EncryptedJson,
  keyMaterial: string,
): Record<string, unknown> {
  if (encrypted.v !== 1 || encrypted.alg !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted JSON format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFromMaterial(keyMaterial),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Encrypted JSON payload must be an object");
  }
  // After type guard, parsed is a non-null, non-array object
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    result[k] = v;
  }
  return result;
}

export function isEncryptedJson(value: unknown): value is EncryptedJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    Reflect.get(value, "v") === 1 &&
    Reflect.get(value, "alg") === "aes-256-gcm" &&
    typeof Reflect.get(value, "iv") === "string" &&
    typeof Reflect.get(value, "tag") === "string" &&
    typeof Reflect.get(value, "ciphertext") === "string"
  );
}
