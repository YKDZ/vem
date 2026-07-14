import { pbkdf2Sync, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PROFILE_CREDENTIAL_KEYS = {
  production: ["administrator", "kiosk"],
  testbed: ["bootstrap", "kiosk"],
};
const PROTECTION_KEYS = ["encryptedAtRest", "access", "cache", "retention"];
const SECRET_FIELD_PATTERN =
  /(?:private.?key|wireguard|wg|peer|certificate|token|secret)/i;
const FORBIDDEN_PRIVATE_NETWORK_MATERIAL_PATTERN =
  /(?:private.?key|wireguard|wg|peer|certificate|token|secret)/i;
const PRODUCTION_FORBIDDEN_PATTERN =
  /(?:ykdz|testbed|test-ca|test-peer|simulator|shared-password)/i;
const MAINTENANCE_PIN_KDF_ITERATIONS = 120000;
const MAINTENANCE_PIN_SALT_BYTES = 16;
const MAINTENANCE_PIN_DIGEST_BYTES = 32;

function isCanonicalPaddedBase64(value, expectedBytes) {
  if (typeof value !== "string") return false;
  const pattern =
    expectedBytes === MAINTENANCE_PIN_SALT_BYTES
      ? /^(?:[A-Za-z0-9+/]{4}){5}[A-Za-z0-9+/][AQgw]==$/
      : expectedBytes === MAINTENANCE_PIN_DIGEST_BYTES
        ? /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/
        : null;
  if (!pattern?.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return (
    decoded.length === expectedBytes && decoded.toString("base64") === value
  );
}

/**
 * Derive the only Factory-deliverable representation of a maintenance PIN.
 * Callers retain the PIN only in process memory; this function deliberately
 * accepts no file path, environment variable, or command-line convention.
 */
export function createMaintenancePinVerifier(pin) {
  if (typeof pin !== "string" || pin.length === 0 || pin.length > 128) {
    throw new TypeError(
      "maintenance PIN must be a non-empty value up to 128 characters",
    );
  }
  const salt = randomBytes(MAINTENANCE_PIN_SALT_BYTES);
  const digest = pbkdf2Sync(
    pin,
    salt,
    MAINTENANCE_PIN_KDF_ITERATIONS,
    MAINTENANCE_PIN_DIGEST_BYTES,
    "sha256",
  );
  return {
    version: 1,
    algorithm: "pbkdf2_hmac_sha256",
    iterations: MAINTENANCE_PIN_KDF_ITERATIONS,
    salt: salt.toString("base64"),
    digest: digest.toString("base64"),
  };
}

export class FactoryPersonalizationMediaError extends Error {
  constructor(issues) {
    super(
      `invalid Factory Personalization Media: ${issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
    this.name = "FactoryPersonalizationMediaError";
    this.issues = issues;
  }
}

function issue(path, message) {
  return { path, message };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, path, issues) {
  if (!isRecord(value)) {
    issues.push(issue(path, "must be an object"));
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      issues.push(issue(`${path}.${key}`, "unknown field is not permitted"));
  }
  return true;
}

function assertCredential(value, path, expectedUser, issues) {
  if (!assertExactKeys(value, ["user", "password"], path, issues)) return;
  if (value.user !== expectedUser) {
    issues.push(issue(`${path}.user`, `must be exactly ${expectedUser}`));
  }
  if (typeof value.password !== "string" || value.password.length < 16) {
    issues.push(
      issue(
        `${path}.password`,
        "must be a non-empty installation credential of at least 16 characters",
      ),
    );
  }
  if (
    typeof value.password === "string" &&
    !/^[\u0020-\u007e]+$/u.test(value.password)
  ) {
    issues.push(
      issue(
        `${path}.password`,
        "must contain only printable ASCII characters safe for Windows answer files",
      ),
    );
  }
  if (
    typeof value.password === "string" &&
    /shared-password/i.test(value.password)
  ) {
    issues.push(
      issue(`${path}.password`, "must not use a shared password marker"),
    );
  }
}

function assertMaintenancePinVerifier(value, issues) {
  if (
    !assertExactKeys(
      value,
      ["version", "algorithm", "iterations", "salt", "digest"],
      "maintenancePinVerifier",
      issues,
    )
  ) {
    return;
  }
  if (value.version !== 1)
    issues.push(issue("maintenancePinVerifier.version", "must be 1"));
  if (value.algorithm !== "pbkdf2_hmac_sha256") {
    issues.push(
      issue("maintenancePinVerifier.algorithm", "must be pbkdf2_hmac_sha256"),
    );
  }
  if (
    !Number.isInteger(value.iterations) ||
    value.iterations < 120000 ||
    value.iterations > 1000000
  ) {
    issues.push(
      issue(
        "maintenancePinVerifier.iterations",
        "must be between 120000 and 1000000",
      ),
    );
  }
  for (const [field, length] of [
    ["salt", MAINTENANCE_PIN_SALT_BYTES],
    ["digest", MAINTENANCE_PIN_DIGEST_BYTES],
  ]) {
    if (!isCanonicalPaddedBase64(value[field], length)) {
      issues.push(
        issue(
          `maintenancePinVerifier.${field}`,
          `must be a ${length}-byte base64 value`,
        ),
      );
    }
  }
}

function assertNoPrivateNetworkMaterial(value, path, issues) {
  if (typeof value === "string") {
    if (FORBIDDEN_PRIVATE_NETWORK_MATERIAL_PATTERN.test(value)) {
      issues.push(
        issue(
          path,
          "private key, peer, WireGuard, or unrelated secret material is not permitted",
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoPrivateNetworkMaterial(entry, `${path}[${index}]`, issues),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      issues.push(
        issue(
          `${path}.${key}`,
          "private key, peer, WireGuard, or unrelated secret field is not permitted",
        ),
      );
    }
    assertNoPrivateNetworkMaterial(entry, `${path}.${key}`, issues);
  }
}

export function validateFactoryPersonalizationMedia(media) {
  const candidate = structuredClone(media);
  const issues = [];
  assertExactKeys(
    candidate,
    [
      "schemaVersion",
      "kind",
      "mediaId",
      "profile",
      "protection",
      "credentials",
      "maintenancePinVerifier",
    ],
    "media",
    issues,
  );
  if (!isRecord(candidate)) throw new FactoryPersonalizationMediaError(issues);

  if (candidate.schemaVersion !== "vem-factory-personalization-media/v1") {
    issues.push(
      issue("schemaVersion", "must be vem-factory-personalization-media/v1"),
    );
  }
  if (candidate.kind !== "factory-personalization-media") {
    issues.push(issue("kind", "must be factory-personalization-media"));
  }
  if (
    typeof candidate.mediaId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{15,127}$/.test(candidate.mediaId)
  ) {
    issues.push(
      issue("mediaId", "must be an opaque lowercase installation identifier"),
    );
  }
  assertMaintenancePinVerifier(candidate.maintenancePinVerifier, issues);
  const hasSupportedProfile = Object.hasOwn(
    PROFILE_CREDENTIAL_KEYS,
    typeof candidate.profile === "string" ? candidate.profile : "",
  );
  if (!hasSupportedProfile) {
    issues.push(issue("profile", "must be production or testbed"));
  }

  if (
    assertExactKeys(candidate.protection, PROTECTION_KEYS, "protection", issues)
  ) {
    if (candidate.protection.encryptedAtRest !== true) {
      issues.push(issue("protection.encryptedAtRest", "must be true"));
    }
    if (candidate.protection.access !== "trusted-protected-gate") {
      issues.push(issue("protection.access", "must be trusted-protected-gate"));
    }
    if (candidate.protection.cache !== "forbidden") {
      issues.push(issue("protection.cache", "must be forbidden"));
    }
    if (candidate.protection.retention !== "installation-lifecycle-only") {
      issues.push(
        issue("protection.retention", "must be installation-lifecycle-only"),
      );
    }
  }

  const credentialKeys = hasSupportedProfile
    ? PROFILE_CREDENTIAL_KEYS[candidate.profile]
    : null;
  if (
    credentialKeys &&
    assertExactKeys(
      candidate.credentials,
      credentialKeys,
      "credentials",
      issues,
    )
  ) {
    if (candidate.profile === "production") {
      assertCredential(
        candidate.credentials.administrator,
        "credentials.administrator",
        "Admin",
        issues,
      );
      assertCredential(
        candidate.credentials.kiosk,
        "credentials.kiosk",
        "VEMKiosk",
        issues,
      );
    } else {
      assertCredential(
        candidate.credentials.bootstrap,
        "credentials.bootstrap",
        "YKDZ",
        issues,
      );
      assertCredential(
        candidate.credentials.kiosk,
        "credentials.kiosk",
        "VEMKiosk",
        issues,
      );
    }
    const passwords = credentialKeys.map(
      (key) => candidate.credentials[key]?.password,
    );
    if (
      passwords.every((password) => typeof password === "string") &&
      new Set(passwords).size !== passwords.length
    ) {
      issues.push(
        issue(
          "credentials",
          "credentials must be unique within one installation",
        ),
      );
    }
  }

  assertNoPrivateNetworkMaterial(candidate, "media", issues);
  if (
    candidate.profile === "production" &&
    PRODUCTION_FORBIDDEN_PATTERN.test(JSON.stringify(candidate))
  ) {
    issues.push(
      issue(
        "profile",
        "production media contains testbed, simulator, or shared-password material",
      ),
    );
  }
  if (issues.length > 0) throw new FactoryPersonalizationMediaError(issues);
  return candidate;
}

export function redactFactoryPersonalizationMedia(
  media,
  { mediaConsumed = true, stagingRetained = false } = {},
) {
  const validated = validateFactoryPersonalizationMedia(media);
  if (mediaConsumed !== true || stagingRetained !== false) {
    throw new FactoryPersonalizationMediaError([
      issue(
        "lifecycle",
        "consumed media redaction requires mediaConsumed true and stagingRetained false",
      ),
    ]);
  }
  const credentialKeys = PROFILE_CREDENTIAL_KEYS[validated.profile];
  return {
    schemaVersion: "vem-factory-personalization-media-redaction/v1",
    kind: "factory-personalization-media-redaction",
    profile: validated.profile,
    protection: { ...validated.protection },
    credentials: Object.fromEntries(
      credentialKeys.map((key) => [key, "configured"]),
    ),
    maintenancePinVerifier: "configured",
    wireGuardPrivateKey: "not-supplied; generated-locally",
    mediaConsumed: true,
    stagingRetained: false,
  };
}

export function previewFactoryPersonalizationMedia(profile) {
  if (
    typeof profile !== "string" ||
    !Object.hasOwn(PROFILE_CREDENTIAL_KEYS, profile)
  ) {
    throw new FactoryPersonalizationMediaError([
      issue("profile", "must be production or testbed"),
    ]);
  }
  return {
    schemaVersion: "vem-factory-personalization-media-preview/v1",
    kind: "factory-personalization-media-preview",
    profile,
    protection: {
      encryptedAtRest: true,
      access: "trusted-protected-gate",
      cache: "forbidden",
      retention: "installation-lifecycle-only",
    },
    credentials: Object.fromEntries(
      PROFILE_CREDENTIAL_KEYS[profile].map((key) => [key, "not-configured"]),
    ),
    maintenancePinVerifier: "not-configured",
    wireGuardPrivateKey: "not-supplied; generated-locally",
    mediaConsumed: false,
    stagingRetained: false,
  };
}

async function readAll(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== bytes.length) {
    throw new FactoryPersonalizationMediaError([
      issue("media", "read was incomplete"),
    ]);
  }
  return bytes;
}

export async function readFactoryPersonalizationMediaSnapshot(mediaPath) {
  const handle = await open(
    mediaPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new FactoryPersonalizationMediaError([
        issue("media", "must be a regular file"),
      ]);
    }
    if (
      typeof process.getuid === "function" &&
      opened.uid !== process.getuid()
    ) {
      throw new FactoryPersonalizationMediaError([
        issue("media", "must be owned by the runner service account"),
      ]);
    }
    if ((opened.mode & 0o077) !== 0) {
      throw new FactoryPersonalizationMediaError([
        issue("media", "must not be group or world readable"),
      ]);
    }
    const bytes = await readAll(handle, opened.size);
    try {
      return {
        bytes,
        media: validateFactoryPersonalizationMedia(
          JSON.parse(bytes.toString("utf8")),
        ),
      };
    } catch (error) {
      if (error instanceof FactoryPersonalizationMediaError) throw error;
      throw new FactoryPersonalizationMediaError([
        issue("media", "must contain valid JSON"),
      ]);
    }
  } finally {
    await handle.close();
  }
}

export async function createFactoryPersonalizationStagingCopy({
  snapshot,
  stagingRoot,
}) {
  if (!snapshot?.bytes || !snapshot?.media) {
    throw new TypeError(
      "createFactoryPersonalizationStagingCopy requires a validated snapshot",
    );
  }
  // This deterministic root is removed before retry and after every completed
  // attempt. It avoids leaving unscannable per-attempt secret directories.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagedPath = join(stagingRoot, "factory-personalization-media.json");
  await writeFile(stagedPath, snapshot.bytes, { mode: 0o600, flag: "wx" });
  await chmod(stagedPath, 0o400);
  const staged = await stat(stagedPath);
  if (!staged.isFile() || (staged.mode & 0o077) !== 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw new FactoryPersonalizationMediaError([
      issue("staging", "must be a private regular file"),
    ]);
  }
  return {
    stagedPath,
    redacted: redactFactoryPersonalizationMedia(snapshot.media, {
      mediaConsumed: true,
      stagingRetained: false,
    }),
    async cleanup() {
      await rm(stagingRoot, { recursive: true, force: true });
      try {
        await stat(stagingRoot);
        throw new FactoryPersonalizationMediaError([
          issue(
            "staging",
            "was unexpectedly retained after installation lifecycle",
          ),
        ]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

export async function stageFactoryPersonalizationMediaSnapshot({
  snapshot,
  stagingRoot,
  use,
}) {
  if (typeof use !== "function") {
    throw new TypeError(
      "stageFactoryPersonalizationMediaSnapshot requires a use callback",
    );
  }
  const staged = await createFactoryPersonalizationStagingCopy({
    snapshot,
    stagingRoot,
  });
  try {
    return await use(staged);
  } finally {
    await staged.cleanup();
  }
}

export function createFactoryPersonalizationUseRegistry() {
  return new Set();
}

export async function withFactoryPersonalizationMedia({
  mediaPath,
  expectedProfile,
  stagingRoot,
  trustedProtectedGate,
  useRegistry,
  use,
}) {
  if (trustedProtectedGate !== true) {
    throw new FactoryPersonalizationMediaError([
      issue(
        "gate",
        "trusted protected gate is required before mounting personalization media",
      ),
    ]);
  }
  if (typeof use !== "function")
    throw new TypeError(
      "withFactoryPersonalizationMedia requires a use callback",
    );
  const snapshot = await readFactoryPersonalizationMediaSnapshot(mediaPath);
  if (snapshot.media.profile !== expectedProfile) {
    throw new FactoryPersonalizationMediaError([
      issue("profile", "does not match the selected Factory profile"),
    ]);
  }
  if (useRegistry?.has(snapshot.media.mediaId)) {
    throw new FactoryPersonalizationMediaError([
      issue(
        "mediaId",
        "has already been consumed during this installation lifecycle",
      ),
    ]);
  }
  useRegistry?.add(snapshot.media.mediaId);
  return stageFactoryPersonalizationMediaSnapshot({
    snapshot,
    stagingRoot,
    use,
  });
}
