import { mqttSigningInput, type MqttSignedEnvelope } from "@vem/shared";

/**
 * Derive an HMAC-SHA256 key from a raw secret string using the Web Crypto API.
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * HMAC-SHA256 the given message and return base64url-encoded signature.
 */
async function hmacSign(key: CryptoKey, message: string): Promise<string> {
  const msgData = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign("HMAC", key, msgData);
  // Base64url encode without padding
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-SHA256 verify: constant-time comparison via Web Crypto verify.
 */
async function hmacVerify(
  key: CryptoKey,
  message: string,
  signatureBase64url: string,
): Promise<boolean> {
  // Decode base64url → ArrayBuffer
  const b64 = signatureBase64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const sigBuf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    sigBuf[i] = binary.charCodeAt(i);
  }

  const msgData = new TextEncoder().encode(message);
  return crypto.subtle.verify("HMAC", key, sigBuf, msgData);
}

export type SignOptions = {
  machineCode: string;
  payload: unknown;
  messageId: string;
  signingSecret: string;
};

/**
 * Create a signed MQTT envelope using the machine's mqttSigningSecret.
 */
export async function signMqttEnvelope(
  opts: SignOptions,
): Promise<MqttSignedEnvelope> {
  const key = await importHmacKey(opts.signingSecret);
  const issuedAt = new Date().toISOString();
  // 16 random bytes → 22 base64url chars (no padding)
  const nonce = (() => {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  })();

  const envelopeWithoutSig = {
    messageId: opts.messageId,
    machineCode: opts.machineCode,
    issuedAt,
    nonce,
    payload: opts.payload,
  };

  const signingInput = mqttSigningInput(envelopeWithoutSig);
  const signature = await hmacSign(key, signingInput);

  return { ...envelopeWithoutSig, signature };
}

export type VerifyOptions = {
  envelope: unknown;
  signingSecret: string;
  /** Allowed drift in seconds (default 300) */
  toleranceSeconds?: number;
};

/**
 * Parse and verify a signed MQTT envelope received from the broker.
 * Throws if signature is invalid or envelope is too old/future.
 */
export async function verifyMqttEnvelope(
  opts: VerifyOptions,
): Promise<MqttSignedEnvelope> {
  if (typeof opts.envelope !== "object" || opts.envelope === null) {
    throw new Error("Invalid envelope: not an object");
  }

  const env = opts.envelope;
  const messageId = Reflect.get(env, "messageId");
  const machineCode = Reflect.get(env, "machineCode");
  const issuedAt = Reflect.get(env, "issuedAt");
  const nonce = Reflect.get(env, "nonce");
  const payload = Reflect.get(env, "payload");
  const signature = Reflect.get(env, "signature");

  if (
    typeof messageId !== "string" ||
    typeof machineCode !== "string" ||
    typeof issuedAt !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    throw new Error("Invalid envelope: missing required fields");
  }

  // Time window check
  const tolerance = opts.toleranceSeconds ?? 300;
  const issued = new Date(issuedAt).getTime();
  const now = Date.now();
  if (Math.abs(now - issued) > tolerance * 1000) {
    throw new Error("Envelope outside time window");
  }

  const envelopeWithoutSig = {
    messageId,
    machineCode,
    issuedAt,
    nonce,
    payload,
  };
  const signingInput = mqttSigningInput(envelopeWithoutSig);

  const key = await importHmacKey(opts.signingSecret);
  const valid = await hmacVerify(key, signingInput, signature);
  if (!valid) {
    throw new Error("Invalid envelope signature");
  }

  return {
    messageId,
    machineCode,
    issuedAt,
    nonce,
    payload,
    signature,
  };
}
