import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";

import {
  deploymentRecord,
  validateAdminProxyHealth,
  validateCommit as validateDeployCommit,
} from "./deploy-backend-stack.mjs";
import {
  imageNames,
  registryBuildArgs,
  validateCommit as validatePublishCommit,
} from "./publish-backend-images.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";
const composePath = new URL(
  "../apps/service-api/docker-compose.yml",
  import.meta.url,
);

function backendEnv(overrides = {}) {
  return {
    POSTGRES_PASSWORD: "postgres-password",
    MQTT_USERNAME: "vem",
    MQTT_PASSWORD: "mqtt-password",
    SERVICE_API_IMAGE: `registry.example/vem-service-api:sha-${commit}`,
    ADMIN_UI_IMAGE: `registry.example/vem-admin-ui:sha-${commit}`,
    JWT_SECRET: "jwt-secret",
    JWT_REFRESH_SECRET: "jwt-refresh-secret",
    BOOTSTRAP_ADMIN_PASSWORD: "admin-password",
    MACHINE_JWT_SECRET: "machine-jwt-secret",
    MACHINE_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: "claim-hmac-key",
    PAYMENT_WEBHOOK_BASE_URL: "https://payments.example/webhooks",
    PAYMENT_CONFIG_ENCRYPTION_KEY: "b".repeat(64),
    ...overrides,
  };
}

function writeEnvFile(path, values) {
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function dockerComposeConfig(envFile) {
  return execFileSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", composePath.pathname, "config"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function dockerComposeSkipReason() {
  try {
    execFileSync("docker", ["compose", "version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return false;
  } catch {
    return "Docker Compose CLI is required for target-host compose config checks";
  }
}

const dockerComposeSkip = dockerComposeSkipReason();

describe("backend image publishing", () => {
  it("requires a full lowercase commit and derives sha tags", () => {
    assert.equal(validatePublishCommit(commit), commit);
    assert.deepEqual(imageNames("registry.example/", commit), [
      `registry.example/vem-service-api:sha-${commit}`,
      `registry.example/vem-admin-ui:sha-${commit}`,
    ]);
    assert.throws(
      () => validatePublishCommit(commit.slice(0, -1)),
      /40-character/,
    );
    assert.throws(
      () => validatePublishCommit(commit.toUpperCase()),
      /40-character/,
    );
  });

  it("passes an explicitly configured package registry to BuildKit", () => {
    assert.deepEqual(
      registryBuildArgs({ NPM_CONFIG_REGISTRY: "https://registry.test/" }),
      ["--build-arg", "NPM_CONFIG_REGISTRY=https://registry.test/"],
    );
    assert.deepEqual(registryBuildArgs({}), []);
  });

  it("keeps the production dependency deployment offline after fetch", () => {
    const dockerfile = readFileSync(
      new URL("../apps/service-api/Dockerfile", import.meta.url),
      "utf8",
    );
    assert.match(
      dockerfile,
      /pnpm --filter service-api deploy --legacy --offline --prod/,
    );
  });
});

describe("backend deployment record", () => {
  it("records the requested commit and repository digests", () => {
    const record = deploymentRecord({
      commit,
      configured: {
        serviceApi: `registry/vem-service-api:sha-${commit}`,
        adminUi: `registry/vem-admin-ui:sha-${commit}`,
      },
      repoDigests: {
        serviceApi: "registry/vem-service-api@sha256:a",
        adminUi: "registry/vem-admin-ui@sha256:b",
      },
      composeFile: "/compose.yml",
      envFile: "/env",
      digestOverride: "/override.yml",
      deployedAt: "2026-07-21T00:00:00.000Z",
    });
    assert.equal(validateDeployCommit(record.requestedCommit), commit);
    assert.deepEqual(record.repoDigests, {
      serviceApi: "registry/vem-service-api@sha256:a",
      adminUi: "registry/vem-admin-ui@sha256:b",
    });
  });

  it("passes every required production endpoint and key into Service API", () => {
    const compose = readFileSync(composePath, "utf8");
    for (const variable of [
      "MACHINE_MQTT_URL",
      "MACHINE_CLAIM_LOOKUP_HMAC_KEY",
      "PAYMENT_WEBHOOK_BASE_URL",
      "PAYMENT_CONFIG_ENCRYPTION_KEY",
    ]) {
      assert.match(compose, new RegExp(`^\\s+${variable}:`, "m"));
    }
  });

  it("keeps one Compose runtime definition with persistent backend state", () => {
    const compose = YAML.parse(readFileSync(composePath, "utf8"));
    assert.deepEqual(Object.keys(compose.services).sort(), [
      "admin-ui",
      "mqtt",
      "postgres",
      "service-api",
    ]);
    assert.equal(
      compose.services.postgres.image,
      "${POSTGRES_IMAGE:-postgres:16}",
    );
    assert.equal(
      compose.services.mqtt.image,
      "${MQTT_IMAGE:-eclipse-mosquitto:2}",
    );
    assert.match(
      compose.services["service-api"].image,
      /\$\{SERVICE_API_IMAGE:\?SERVICE_API_IMAGE must be sha-<40-character-commit>\}/,
    );
    assert.match(
      compose.services["admin-ui"].image,
      /\$\{ADMIN_UI_IMAGE:\?ADMIN_UI_IMAGE must be sha-<40-character-commit>\}/,
    );
    assert.ok(compose.services.postgres.healthcheck);
    assert.ok(compose.services.mqtt.healthcheck);
    assert.ok(compose.services["service-api"].healthcheck);
    assert.ok(compose.services["admin-ui"].healthcheck);
    assert.deepEqual(compose.services.postgres.volumes, [
      "vem-postgres-data:/var/lib/postgresql/data",
    ]);
    assert.deepEqual(compose.services.mqtt.volumes, [
      "vem-mqtt-data:/mosquitto/data",
    ]);
    assert.deepEqual(compose.services["service-api"].volumes, [
      "vem-service-api-media-assets:/var/lib/vem/service-api/media-assets",
    ]);
    assert.equal(
      compose.services["service-api"].environment.MEDIA_ASSET_STORAGE_ROOT,
      "/var/lib/vem/service-api/media-assets",
    );
    assert.ok("vem-postgres-data" in compose.volumes);
    assert.ok("vem-mqtt-data" in compose.volumes);
    assert.ok("vem-service-api-media-assets" in compose.volumes);
  });

  it(
    "validates the target-host Compose artifact from only env plus compose",
    { skip: dockerComposeSkip },
    () => {
      const temp = mkdtempSync(join(tmpdir(), "vem-backend-compose-"));
      try {
        const envPath = join(temp, "backend.env");
        writeEnvFile(envPath, backendEnv());
        const rendered = dockerComposeConfig(envPath);
        assert.match(rendered, /registry\.example\/vem-service-api:sha-/);
        assert.match(rendered, /registry\.example\/vem-admin-ui:sha-/);
        assert.match(rendered, /vem-service-api-media-assets/);
        assert.match(rendered, /MEDIA_ASSET_STORAGE_ROOT/);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects a target-host Compose env missing required app images",
    { skip: dockerComposeSkip },
    () => {
      const temp = mkdtempSync(join(tmpdir(), "vem-backend-compose-"));
      try {
        const envPath = join(temp, "backend.env");
        const { SERVICE_API_IMAGE: _removed, ...env } = backendEnv();
        writeEnvFile(envPath, env);
        assert.throws(
          () => dockerComposeConfig(envPath),
          /SERVICE_API_IMAGE must be sha-<40-character-commit>/,
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("checks the wrapped health response used by the production API", () => {
    const compose = readFileSync(composePath, "utf8");
    assert.match(compose, /b\.data\?\.database !== 'ok'/);
    assert.match(compose, /b\.data\?\.mqtt !== 'connected'/);
  });

  it("requires backend health through the Admin UI proxy", () => {
    assert.deepEqual(
      validateAdminProxyHealth(
        JSON.stringify({ data: { database: "ok", mqtt: "connected" } }),
      ).data,
      { database: "ok", mqtt: "connected" },
    );
    assert.throws(
      () => validateAdminProxyHealth("<html>admin</html>"),
      /did not return JSON/,
    );
    assert.throws(
      () =>
        validateAdminProxyHealth(
          JSON.stringify({ data: { database: "ok", mqtt: "disconnected" } }),
        ),
      /healthy backend state/,
    );
  });
});
