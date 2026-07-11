import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestSchema = JSON.parse(
  readFileSync(
    new URL("../../public/factory-manifest-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const schemaValidator = new Ajv2020({ allErrors: true, strict: true }).compile(
  manifestSchema,
);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_PATTERN = /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;
const ASSET_ROLES = new Set([
  "windows-source-iso",
  "openssh-installer",
  "wireguard-installer",
  "vem-daemon",
  "vem-machine-ui",
  "webview2-loader",
  "vision-release",
]);
const REQUIRED_ASSET_ROLES = new Set([
  "openssh-installer",
  "wireguard-installer",
  "vem-daemon",
  "vem-machine-ui",
  "webview2-loader",
  "vision-release",
]);
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "manifestId",
  "profile",
  "source",
  "assets",
  "toolchain",
  "outputPolicy",
];
const ASSET_KEYS = [
  "role",
  "identity",
  "digest",
  "version",
  "signature",
  "provenance",
  "release",
];
const VISION_RELEASE_KEYS = [
  "descriptorIdentity",
  "descriptorDigest",
  "attestationIdentity",
  "attestationDigest",
  "approvalIdentity",
  "approvalDigest",
  "conformanceEvidenceIdentity",
  "conformanceEvidenceDigest",
];

export class FactoryManifestError extends Error {
  constructor(issues) {
    super(
      `invalid Factory Manifest: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
    this.name = "FactoryManifestError";
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
    return;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      issues.push(issue(`${path}.${key}`, "unknown field is not permitted"));
    }
  }
}

function requiredString(value, path, issues) {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue(path, "must be a non-empty string"));
  }
}

function fixedVersion(value, path, issues) {
  requiredString(value, path, issues);
  if (
    typeof value === "string" &&
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  ) {
    issues.push(issue(path, "must be a strict semantic version"));
  }
}

function assertDigest(value, path, issues) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    issues.push(issue(path, "must be a lowercase sha256:<64 hex> digest"));
  }
}

function assertAsset(value, path, issues) {
  assertExactKeys(value, ASSET_KEYS, path, issues);
  if (!isRecord(value)) return;

  if (typeof value.role !== "string" || !ASSET_ROLES.has(value.role)) {
    issues.push(
      issue(`${path}.role`, "must be a supported immutable asset role"),
    );
  }
  const identityMatch =
    typeof value.identity === "string"
      ? value.identity.match(IDENTITY_PATTERN)
      : null;
  if (!identityMatch) {
    issues.push(
      issue(
        `${path}.identity`,
        "must be a factory-cas://sha256/<64 hex> identity",
      ),
    );
  }
  assertDigest(value.digest, `${path}.digest`, issues);
  if (identityMatch && value.digest !== `sha256:${identityMatch[1]}`) {
    issues.push(
      issue(`${path}.digest`, "must match the content-addressed identity"),
    );
  }
  fixedVersion(value.version, `${path}.version`, issues);

  assertExactKeys(
    value.signature,
    ["scheme", "signerIdentity", "evidenceIdentity", "evidenceDigest"],
    `${path}.signature`,
    issues,
  );
  if (isRecord(value.signature)) {
    if (
      value.signature.scheme !== "detached-ed25519" &&
      value.signature.scheme !== "authenticode"
    ) {
      issues.push(
        issue(
          `${path}.signature.scheme`,
          "must be detached-ed25519 or authenticode",
        ),
      );
    }
    requiredString(
      value.signature.signerIdentity,
      `${path}.signature.signerIdentity`,
      issues,
    );
    if (value.signature.scheme === "authenticode") {
      if (
        !/^x509-sha256:[a-f0-9]{64}$/.test(value.signature.signerIdentity ?? "")
      ) {
        issues.push(
          issue(
            `${path}.signature.signerIdentity`,
            "must be an x509-sha256 certificate identity",
          ),
        );
      }
      if (
        value.signature.evidenceIdentity !== value.identity ||
        value.signature.evidenceDigest !== value.digest
      ) {
        issues.push(
          issue(
            `${path}.signature.evidenceIdentity`,
            "AuthentiCode evidence must be the signed asset bytes",
          ),
        );
      }
    } else {
      assertEvidenceReference(value.signature, `${path}.signature`, issues);
    }
  }

  assertExactKeys(
    value.provenance,
    [
      "predicateType",
      "sourceIdentity",
      "builderIdentity",
      "buildId",
      "signerIdentity",
      "evidenceIdentity",
      "evidenceDigest",
    ],
    `${path}.provenance`,
    issues,
  );
  if (isRecord(value.provenance)) {
    if (value.provenance.predicateType !== "https://slsa.dev/provenance/v1") {
      issues.push(
        issue(
          `${path}.provenance.predicateType`,
          "must be https://slsa.dev/provenance/v1",
        ),
      );
    }
    for (const key of [
      "sourceIdentity",
      "builderIdentity",
      "buildId",
      "signerIdentity",
    ]) {
      requiredString(
        value.provenance[key],
        `${path}.provenance.${key}`,
        issues,
      );
    }
    assertEvidenceReference(value.provenance, `${path}.provenance`, issues);
  }

  if (value.role === "vision-release") {
    assertExactKeys(
      value.release,
      VISION_RELEASE_KEYS,
      `${path}.release`,
      issues,
    );
    if (isRecord(value.release)) {
      for (const key of VISION_RELEASE_KEYS) {
        if (key.endsWith("Identity")) {
          const digestKey = `${key.slice(0, -"Identity".length)}Digest`;
          const match = /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/.exec(
            value.release[key] ?? "",
          );
          if (!match) {
            issues.push(
              issue(
                `${path}.release.${key}`,
                "must be a content-addressed evidence identity",
              ),
            );
          }
          assertDigest(
            value.release[digestKey],
            `${path}.release.${digestKey}`,
            issues,
          );
          if (match && value.release[digestKey] !== `sha256:${match[1]}`) {
            issues.push(
              issue(
                `${path}.release.${digestKey}`,
                "must match the evidence identity",
              ),
            );
          }
        }
      }
    }
  } else if (value.release !== undefined) {
    issues.push(
      issue(`${path}.release`, "is only permitted for vision-release"),
    );
  }
}

function assertEvidenceReference(value, path, issues) {
  const identityMatch =
    typeof value.evidenceIdentity === "string"
      ? /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/.exec(
          value.evidenceIdentity,
        )
      : null;
  if (!identityMatch) {
    issues.push(
      issue(
        `${path}.evidenceIdentity`,
        "must be a content-addressed evidence identity",
      ),
    );
  }
  assertDigest(value.evidenceDigest, `${path}.evidenceDigest`, issues);
  if (identityMatch && value.evidenceDigest !== `sha256:${identityMatch[1]}`) {
    issues.push(
      issue(`${path}.evidenceDigest`, "must match the evidence identity"),
    );
  }
}

function assertNoForbiddenContent(value, path, issues) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenContent(entry, `${path}[${index}]`, issues),
    );
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string") {
      let inspected = value;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const decoded = decodeURIComponent(inspected);
          if (decoded === inspected) break;
          inspected = decoded;
        } catch {
          break;
        }
      }
      if (
        /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|passwd|secret|token|authorization)\s*[:=]|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\b(?:gh[opsu]|github_pat|sk)-[A-Za-z0-9_-]{16,}/i.test(
          inspected,
        )
      ) {
        issues.push(
          issue(path, "embedded secret or private key is not permitted"),
        );
      }
      if (/^file:/i.test(inspected)) {
        issues.push(issue(path, "file URI is not permitted"));
      }
      if (/^(?:[A-Za-z]:[\\/]|\/(?:[^/]+(?:\/|$)){1,}|\\\\)/.test(inspected)) {
        issues.push(issue(path, "host paths are not permitted"));
      }
      if (
        (/^(?:https?|git|ssh):\/\//i.test(inspected) &&
          inspected !== "https://slsa.dev/provenance/v1") ||
        /(?:@|:)latest(?:$|\W)/i.test(inspected)
      ) {
        issues.push(
          issue(path, "mutable or network source references are not permitted"),
        );
      }
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      /secret|private.?key|password|passwd|token|credential|host.?path|source.?path|local.?path/i.test(
        key,
      )
    ) {
      issues.push(
        issue(`${path}.${key}`, "secret or host-path field is not permitted"),
      );
    }
    assertNoForbiddenContent(entry, `${path}.${key}`, issues);
  }
}

function assertProfileBoundary(manifest, issues) {
  if (manifest.profile !== "production" && manifest.profile !== "testbed") {
    issues.push(issue("profile", "must be production or testbed"));
    return;
  }
  if (manifest.profile === "production") {
    const serialized = JSON.stringify(manifest);
    for (const token of ["testbed", "ykdz", "simulator", "fixture"]) {
      if (serialized.toLowerCase().includes(token)) {
        issues.push(
          issue(
            "profile",
            `production manifest contains testbed-only token ${token}`,
          ),
        );
      }
    }
  }
}

function validateManifestShape(manifest, { requireManifestId }) {
  const issues = [];
  if (requireManifestId && !schemaValidator(manifest)) {
    for (const error of schemaValidator.errors ?? []) {
      const suffix =
        error.keyword === "additionalProperties"
          ? `.${error.params.additionalProperty}`
          : "";
      issues.push(
        issue(
          `manifest${error.instancePath.replaceAll("/", ".")}${suffix}`,
          error.keyword === "additionalProperties"
            ? "unknown field is not permitted"
            : (error.message ?? "does not match the published schema"),
        ),
      );
    }
  }
  assertExactKeys(manifest, TOP_LEVEL_KEYS, "manifest", issues);
  if (!isRecord(manifest)) return issues;

  if (manifest.schemaVersion !== "vem-factory-manifest/v1") {
    issues.push(issue("schemaVersion", "must be vem-factory-manifest/v1"));
  }
  if (manifest.kind !== "factory-manifest") {
    issues.push(issue("kind", "must be factory-manifest"));
  }
  if (requireManifestId) {
    const idMatch =
      typeof manifest.manifestId === "string"
        ? manifest.manifestId.match(DIGEST_PATTERN)
        : null;
    if (!idMatch)
      issues.push(issue("manifestId", "must be a sha256:<64 hex> identity"));
  }
  assertProfileBoundary(manifest, issues);

  assertExactKeys(manifest.source, ["windowsMedia"], "source", issues);
  if (isRecord(manifest.source)) {
    assertAsset(manifest.source.windowsMedia, "source.windowsMedia", issues);
    if (manifest.source.windowsMedia?.role !== "windows-source-iso") {
      issues.push(
        issue("source.windowsMedia.role", "must be exactly windows-source-iso"),
      );
    }
  }

  if (!Array.isArray(manifest.assets)) {
    issues.push(issue("assets", "must be an array"));
  } else {
    if (manifest.assets.length !== REQUIRED_ASSET_ROLES.size) {
      issues.push(
        issue(
          "assets",
          `must contain exactly ${REQUIRED_ASSET_ROLES.size} runtime assets`,
        ),
      );
    }
    const roles = new Set();
    manifest.assets.forEach((assetValue, index) => {
      assertAsset(assetValue, `assets[${index}]`, issues);
      if (isRecord(assetValue) && typeof assetValue.role === "string") {
        if (roles.has(assetValue.role))
          issues.push(issue(`assets[${index}].role`, "duplicate asset role"));
        roles.add(assetValue.role);
      }
    });
    for (const role of REQUIRED_ASSET_ROLES) {
      if (!roles.has(role))
        issues.push(issue("assets", `missing required asset role ${role}`));
    }
    const allAssets = [manifest.source?.windowsMedia, ...manifest.assets];
    if (
      allAssets.some((asset) => asset?.signature?.scheme === "authenticode") &&
      !isRecord(manifest.toolchain?.authenticodeVerifier)
    ) {
      issues.push(
        issue(
          "toolchain.authenticodeVerifier",
          "is required when any asset uses AuthentiCode evidence",
        ),
      );
    }
  }

  assertExactKeys(
    manifest.toolchain,
    ["builderImage", "isoBuilder", "authenticodeVerifier"],
    "toolchain",
    issues,
  );
  if (isRecord(manifest.toolchain)) {
    assertExactKeys(
      manifest.toolchain.builderImage,
      ["identity", "digest", "version"],
      "toolchain.builderImage",
      issues,
    );
    if (isRecord(manifest.toolchain.builderImage)) {
      requiredString(
        manifest.toolchain.builderImage.identity,
        "toolchain.builderImage.identity",
        issues,
      );
      assertDigest(
        manifest.toolchain.builderImage.digest,
        "toolchain.builderImage.digest",
        issues,
      );
      fixedVersion(
        manifest.toolchain.builderImage.version,
        "toolchain.builderImage.version",
        issues,
      );
      if (
        typeof manifest.toolchain.builderImage.identity === "string" &&
        !/@sha256:[a-f0-9]{64}$/.test(manifest.toolchain.builderImage.identity)
      ) {
        issues.push(
          issue("toolchain.builderImage.identity", "must be pinned by digest"),
        );
      }
      assertToolIdentityDigest(
        manifest.toolchain.builderImage,
        "toolchain.builderImage",
        issues,
      );
    }
    assertExactKeys(
      manifest.toolchain.isoBuilder,
      ["identity", "digest", "version"],
      "toolchain.isoBuilder",
      issues,
    );
    if (isRecord(manifest.toolchain.isoBuilder)) {
      requiredString(
        manifest.toolchain.isoBuilder.identity,
        "toolchain.isoBuilder.identity",
        issues,
      );
      assertDigest(
        manifest.toolchain.isoBuilder.digest,
        "toolchain.isoBuilder.digest",
        issues,
      );
      fixedVersion(
        manifest.toolchain.isoBuilder.version,
        "toolchain.isoBuilder.version",
        issues,
      );
      if (
        typeof manifest.toolchain.isoBuilder.identity === "string" &&
        !/@sha256:[a-f0-9]{64}$/.test(manifest.toolchain.isoBuilder.identity)
      ) {
        issues.push(
          issue("toolchain.isoBuilder.identity", "must be pinned by digest"),
        );
      }
      assertToolIdentityDigest(
        manifest.toolchain.isoBuilder,
        "toolchain.isoBuilder",
        issues,
      );
    }
    if (manifest.toolchain.authenticodeVerifier !== undefined) {
      assertExactKeys(
        manifest.toolchain.authenticodeVerifier,
        ["identity", "digest", "version"],
        "toolchain.authenticodeVerifier",
        issues,
      );
      if (isRecord(manifest.toolchain.authenticodeVerifier)) {
        requiredString(
          manifest.toolchain.authenticodeVerifier.identity,
          "toolchain.authenticodeVerifier.identity",
          issues,
        );
        assertDigest(
          manifest.toolchain.authenticodeVerifier.digest,
          "toolchain.authenticodeVerifier.digest",
          issues,
        );
        fixedVersion(
          manifest.toolchain.authenticodeVerifier.version,
          "toolchain.authenticodeVerifier.version",
          issues,
        );
        assertToolIdentityDigest(
          manifest.toolchain.authenticodeVerifier,
          "toolchain.authenticodeVerifier",
          issues,
        );
      }
    }
  }

  assertExactKeys(
    manifest.outputPolicy,
    ["isoFileName", "reproducible", "includeProvenance", "assemblyMode"],
    "outputPolicy",
    issues,
  );
  if (isRecord(manifest.outputPolicy)) {
    requiredString(
      manifest.outputPolicy.isoFileName,
      "outputPolicy.isoFileName",
      issues,
    );
    if (
      typeof manifest.outputPolicy.isoFileName === "string" &&
      manifest.outputPolicy.isoFileName !== "vem-factory-{manifestId}.iso"
    ) {
      issues.push(
        issue(
          "outputPolicy.isoFileName",
          "must use the canonical manifest identity filename",
        ),
      );
    }
    if (manifest.outputPolicy.reproducible !== true)
      issues.push(issue("outputPolicy.reproducible", "must be true"));
    if (manifest.outputPolicy.includeProvenance !== true)
      issues.push(issue("outputPolicy.includeProvenance", "must be true"));
    if (manifest.outputPolicy.assemblyMode !== "bootable-fixture-envelope") {
      issues.push(
        issue(
          "outputPolicy.assemblyMode",
          "must honestly declare bootable-fixture-envelope until Issue15",
        ),
      );
    }
  }
  assertNoForbiddenContent(manifest, "manifest", issues);
  return issues;
}

function assertToolIdentityDigest(tool, path, issues) {
  const match =
    typeof tool.identity === "string"
      ? /@sha256:([a-f0-9]{64})$/.exec(tool.identity)
      : null;
  if (match && tool.digest !== `sha256:${match[1]}`) {
    issues.push(issue(`${path}.digest`, "must match the identity URI digest"));
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function manifestIdentity(manifest) {
  const withoutIdentity = { ...manifest };
  delete withoutIdentity.manifestId;
  return `sha256:${createHash("sha256").update(canonicalJson(withoutIdentity)).digest("hex")}`;
}

export function createFactoryManifest(input) {
  const candidate = structuredClone(input);
  delete candidate.manifestId;
  candidate.manifestId = manifestIdentity(candidate);
  return validateFactoryManifest(candidate);
}

export function validateFactoryManifest(manifest) {
  const candidate = structuredClone(manifest);
  const issues = validateManifestShape(candidate, { requireManifestId: true });
  if (
    issues.length === 0 &&
    candidate.manifestId !== manifestIdentity(candidate)
  ) {
    issues.push(
      issue("manifestId", "does not match the canonical manifest content"),
    );
  }
  if (issues.length > 0) throw new FactoryManifestError(issues);
  return candidate;
}

export function digestFromIdentity(identity) {
  const match =
    typeof identity === "string" ? identity.match(IDENTITY_PATTERN) : null;
  if (!match)
    throw new FactoryManifestError([
      issue("identity", "must be a content-addressed SHA-256 identity"),
    ]);
  return `sha256:${match[1]}`;
}

export { ASSET_ROLES };
