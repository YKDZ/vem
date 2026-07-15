import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createMaintenancePinVerifier,
  createFactoryPersonalizationUseRegistry,
  FactoryPersonalizationMediaError,
  previewFactoryPersonalizationMedia,
  redactFactoryPersonalizationMedia,
  validateFactoryPersonalizationMedia,
  withFactoryPersonalizationMedia,
} from "./factory-personalization-media.mjs";

function productionMedia(overrides = {}) {
  return {
    schemaVersion: "vem-factory-personalization-media/v1",
    kind: "factory-personalization-media",
    mediaId: "factory-personalization-prod-000001",
    profile: "production",
    protection: {
      encryptedAtRest: true,
      access: "trusted-protected-gate",
      cache: "forbidden",
      retention: "installation-lifecycle-only",
    },
    credentials: {
      administrator: { user: "Admin", password: "unique-production-admin-1" },
      kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
    },
    maintenancePinVerifier: {
      version: 1,
      algorithm: "pbkdf2_hmac_sha256",
      iterations: 120000,
      salt: "ABEiM0RVZneImaq7zN3u/w==",
      digest: "jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0=",
    },
    ...overrides,
  };
}

function testbedMedia(overrides = {}) {
  return {
    schemaVersion: "vem-factory-personalization-media/v1",
    kind: "factory-personalization-media",
    mediaId: "factory-personalization-testbed-000001",
    profile: "testbed",
    protection: {
      encryptedAtRest: true,
      access: "trusted-protected-gate",
      cache: "forbidden",
      retention: "installation-lifecycle-only",
    },
    credentials: {
      bootstrap: { user: "YKDZ", password: "dedicated-testbed-bootstrap-1" },
      kiosk: { user: "VEMKiosk", password: "dedicated-testbed-kiosk-1" },
    },
    maintenancePinVerifier: {
      version: 1,
      algorithm: "pbkdf2_hmac_sha256",
      iterations: 120000,
      salt: "ABEiM0RVZneImaq7zN3u/w==",
      digest: "jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0=",
    },
    ...overrides,
  };
}

describe("Factory Personalization Media v1", () => {
  it("derives a fresh salted verifier from a Factory PIN without retaining the PIN", () => {
    const pin = "2468";
    const first = createMaintenancePinVerifier(pin);
    const second = createMaintenancePinVerifier(pin);

    for (const verifier of [first, second]) {
      assert.equal(verifier.version, 1);
      assert.equal(verifier.algorithm, "pbkdf2_hmac_sha256");
      assert.equal(verifier.iterations, 120000);
      assert.equal(Buffer.from(verifier.salt, "base64").length, 16);
      assert.equal(Buffer.from(verifier.digest, "base64").length, 32);
      assert.doesNotMatch(JSON.stringify(verifier), new RegExp(pin));
    }
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.digest, second.digest);
  });

  it("accepts only profile-appropriate credentials and redacts all secret values", () => {
    const production = validateFactoryPersonalizationMedia(productionMedia());
    const testbed = validateFactoryPersonalizationMedia(testbedMedia());

    assert.equal(production.profile, "production");
    assert.equal(testbed.profile, "testbed");
    assert.deepEqual(redactFactoryPersonalizationMedia(production), {
      schemaVersion: "vem-factory-personalization-media-redaction/v1",
      kind: "factory-personalization-media-redaction",
      profile: "production",
      protection: {
        encryptedAtRest: true,
        access: "trusted-protected-gate",
        cache: "forbidden",
        retention: "installation-lifecycle-only",
      },
      credentials: { administrator: "configured", kiosk: "configured" },
      maintenancePinVerifier: "configured",
      wireGuardPrivateKey: "not-supplied; generated-locally",
      mediaConsumed: true,
      stagingRetained: false,
    });
    assert.doesNotMatch(
      JSON.stringify(redactFactoryPersonalizationMedia(production)),
      /unique-production|mediaId|digest|identity/i,
    );
  });

  it("rejects unknown fields, case variants of forbidden material, and arbitrary profiles", () => {
    for (const candidate of [
      productionMedia({ unexpected: true }),
      productionMedia({ wireGuardPrivateKey: "not-allowed" }),
      productionMedia({
        credentials: {
          administrator: { user: "Admin", password: "SHARED-PASSWORD-123" },
          kiosk: { user: "VEMKiosk", password: "shared-password-456" },
        },
      }),
      testbedMedia({
        credentials: {
          bootstrap: { user: "YKDZ", password: "dedicated-WireGuard-123" },
          kiosk: { user: "VEMKiosk", password: "dedicated-testbed-kiosk-1" },
        },
      }),
      productionMedia({
        credentials: {
          administrator: {
            user: "YKDZ",
            password: "unique-production-admin-1",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
      testbedMedia({
        credentials: {
          administrator: {
            user: "Admin",
            password: "unique-production-admin-1",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
      productionMedia({ profile: "toString" }),
      productionMedia({ profile: "__proto__" }),
      productionMedia({
        credentials: {
          administrator: {
            user: "Admin",
            password: "unique-admin-with-control\u0001",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
      productionMedia({
        credentials: {
          administrator: {
            user: "Admin",
            password: "unique-admin-invalid-\ufffe",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
    ]) {
      assert.throws(
        () => validateFactoryPersonalizationMedia(candidate),
        FactoryPersonalizationMediaError,
      );
    }
  });

  it("keeps JavaScript, schema, and PowerShell media and evidence contracts in parity", async () => {
    const schema = JSON.parse(
      await readFile(
        "public/factory-personalization-media-v1.schema.json",
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ strict: false });
    const validateMedia = ajv.compile(schema);
    assert.equal(validateMedia(productionMedia()), true, ajv.errorsText());
    for (const candidate of [
      productionMedia({
        maintenancePinVerifier: {
          ...productionMedia().maintenancePinVerifier,
          salt: "ABEiM0RVZneImaq7zN3u/w",
        },
      }),
      productionMedia({
        maintenancePinVerifier: {
          ...productionMedia().maintenancePinVerifier,
          digest: "jEOlq6tvHWcnp7Q9bZdfXkpFrllYswV3vYr250nTqJ0",
        },
      }),
    ]) {
      assert.equal(validateMedia(candidate), false, ajv.errorsText());
      assert.throws(
        () => validateFactoryPersonalizationMedia(candidate),
        FactoryPersonalizationMediaError,
      );
    }
    assert.throws(
      () =>
        validateFactoryPersonalizationMedia(
          productionMedia({
            maintenancePinVerifier: {
              ...productionMedia().maintenancePinVerifier,
              // This decodes to the same bytes as the canonical /w== form,
              // but the unused final bits make the representation ambiguous.
              salt: "ABEiM0RVZneImaq7zN3u/x==",
            },
          }),
        ),
      FactoryPersonalizationMediaError,
    );
    assert.equal(
      validateMedia({
        ...productionMedia(),
        protection: {
          ...productionMedia().protection,
          encryptedAtRest: "true",
        },
      }),
      false,
    );
    for (const candidate of [
      productionMedia({ profile: "toString" }),
      productionMedia({ profile: "__proto__" }),
      productionMedia({
        credentials: {
          administrator: { user: "Admin", password: "SHARED-PASSWORD-123" },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
      testbedMedia({
        credentials: {
          bootstrap: { user: "YKDZ", password: "dedicated-WireGuard-123" },
          kiosk: { user: "VEMKiosk", password: "dedicated-testbed-kiosk-1" },
        },
      }),
      productionMedia({
        credentials: {
          administrator: {
            user: "Admin",
            password: "unique-admin-with-newline\n",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
      productionMedia({
        credentials: {
          administrator: {
            user: "Admin",
            password: "unique-admin-invalid-\ufffe",
          },
          kiosk: { user: "VEMKiosk", password: "unique-production-kiosk-1" },
        },
      }),
    ]) {
      assert.equal(validateMedia(candidate), false, ajv.errorsText());
      assert.throws(
        () => validateFactoryPersonalizationMedia(candidate),
        FactoryPersonalizationMediaError,
      );
    }
    const validateRedaction = ajv.compile({
      $ref: `${schema.$id}#/$defs/redaction`,
    });
    const redaction = redactFactoryPersonalizationMedia(productionMedia(), {
      mediaConsumed: true,
      stagingRetained: false,
    });
    assert.equal(validateRedaction(redaction), true, ajv.errorsText());
    const preview = previewFactoryPersonalizationMedia("production");
    assert.equal(validateRedaction(preview), true, ajv.errorsText());
    assert.throws(
      () =>
        redactFactoryPersonalizationMedia(productionMedia(), {
          mediaConsumed: false,
          stagingRetained: false,
        }),
      FactoryPersonalizationMediaError,
    );
    assert.equal(
      validateRedaction({
        ...redaction,
        credentials: { maintenance: "configured", kiosk: "configured" },
      }),
      false,
    );
  });

  it("requires independent adapter cleanup-only lifecycle verification", async () => {
    const workflow = await readFile(
      ".github/workflows/factory-image-acceptance.yml",
      "utf8",
    );
    assert.match(
      workflow,
      /Independently Finalize Adapter Lifecycle\n        if: \$\{\{ always\(\) \}\}/,
    );
    assert.match(workflow, /--cleanup-only/);
    assert.doesNotMatch(workflow, /--cleanup-factory-staging/);
  });

  it("stages media only after the trusted gate and always removes deterministic staging on failure and retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-personalization-test-"));
    const mediaPath = join(root, "personalization.json");
    const stagingRoot = join(root, "staging");
    const media = productionMedia();
    await writeFile(mediaPath, JSON.stringify(media), { mode: 0o600 });
    try {
      await assert.rejects(
        withFactoryPersonalizationMedia({
          mediaPath,
          expectedProfile: "production",
          stagingRoot,
          trustedProtectedGate: false,
          use: async () => undefined,
        }),
        /trusted protected gate/i,
      );

      await assert.rejects(
        withFactoryPersonalizationMedia({
          mediaPath,
          expectedProfile: "testbed",
          stagingRoot,
          trustedProtectedGate: true,
          use: async () => undefined,
        }),
        /does not match the selected Factory profile/i,
      );

      const registry = createFactoryPersonalizationUseRegistry();
      const result = await withFactoryPersonalizationMedia({
        mediaPath,
        expectedProfile: "production",
        stagingRoot,
        trustedProtectedGate: true,
        useRegistry: registry,
        use: async ({ stagedPath, redacted }) => ({
          staged: JSON.parse(await readFile(stagedPath, "utf8")),
          redacted,
        }),
      });
      assert.equal(
        result.staged.credentials.administrator.password,
        "unique-production-admin-1",
      );
      assert.deepEqual(result.redacted.credentials, {
        administrator: "configured",
        kiosk: "configured",
      });
      assert.equal(result.redacted.mediaConsumed, true);
      assert.equal(existsSync(stagingRoot), false);

      await assert.rejects(
        withFactoryPersonalizationMedia({
          mediaPath,
          expectedProfile: "production",
          stagingRoot,
          trustedProtectedGate: true,
          useRegistry: registry,
          use: async () => undefined,
        }),
        /already been consumed/i,
      );

      await assert.rejects(
        withFactoryPersonalizationMedia({
          mediaPath,
          expectedProfile: "production",
          stagingRoot,
          trustedProtectedGate: true,
          use: async () => {
            throw new Error("cancelled while installing");
          },
        }),
        /cancelled while installing/,
      );
      const stagedEntries = await readFile(mediaPath, "utf8");
      assert.match(stagedEntries, /unique-production-admin-1/);
      assert.equal(existsSync(stagingRoot), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads a private staged copy of descriptor-read bytes despite a source path swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-personalization-toctou-"));
    const mediaPath = join(root, "personalization.json");
    const stagingRoot = join(root, "staging");
    await writeFile(mediaPath, JSON.stringify(productionMedia()), {
      mode: 0o600,
    });
    try {
      const result = await withFactoryPersonalizationMedia({
        mediaPath,
        expectedProfile: "production",
        stagingRoot,
        trustedProtectedGate: true,
        use: async ({ stagedPath }) => {
          await writeFile(
            mediaPath,
            JSON.stringify(
              productionMedia({
                credentials: {
                  administrator: {
                    user: "Admin",
                    password: "attacker-replaced-admin-credential",
                  },
                  kiosk: {
                    user: "VEMKiosk",
                    password: "attacker-replaced-kiosk-credential",
                  },
                },
              }),
            ),
            { mode: 0o600 },
          );
          return JSON.parse(await readFile(stagedPath, "utf8"));
        },
      });
      assert.equal(
        result.credentials.administrator.password,
        "unique-production-admin-1",
      );
      assert.doesNotMatch(JSON.stringify(result), /attacker-replaced/);
      assert.equal(existsSync(stagingRoot), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
