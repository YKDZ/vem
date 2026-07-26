import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";

import {
  backendComposeSmokeEnv,
  composeCommand,
  targetHostComposeCommand,
} from "./backend-compose-smoke.mjs";
import {
  validateAdminProxyHealth,
  validateDigestPinnedImage,
  validatePaymentWebhookBaseUrl,
} from "./backend-deployment-validation.mjs";
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
const packagePath = new URL("../package.json", import.meta.url);
const legacyDeploymentScript = new URL(
  "./deploy-backend-stack.mjs",
  import.meta.url,
);

function backendEnv(overrides = {}) {
  return {
    POSTGRES_PASSWORD: "postgres-password",
    MQTT_USERNAME: "vem",
    MQTT_PASSWORD: "mqtt-password",
    SERVICE_API_IMAGE: `registry.example/vem-service-api@sha256:${"a".repeat(64)}`,
    ADMIN_UI_IMAGE: `registry.example/vem-admin-ui@sha256:${"b".repeat(64)}`,
    JWT_SECRET: "jwt-secret",
    JWT_REFRESH_SECRET: "jwt-refresh-secret",
    BOOTSTRAP_ADMIN_PASSWORD: "admin-password",
    MACHINE_JWT_SECRET: "machine-jwt-secret",
    MACHINE_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
    MACHINE_CLAIM_LOOKUP_HMAC_KEY: "claim-hmac-key",
    MACHINE_API_BASE_URL: "https://machines.example.com/api",
    MACHINE_MQTT_URL: "mqtt://machines.example.com:1883",
    PAYMENT_WEBHOOK_BASE_URL: "https://payments.example",
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

describe("backend Compose deployment contract", () => {
  it("exposes no repository command that deploys the backend stack", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    assert.equal(packageJson.scripts["deploy:backend"], undefined);
    assert.equal(existsSync(legacyDeploymentScript), false);
  });

  it("builds a bounded production-like Compose smoke env", () => {
    const env = backendComposeSmokeEnv({
      serviceApiImage: `registry/vem-service-api@sha256:${"c".repeat(64)}`,
      adminUiImage: `registry/vem-admin-ui@sha256:${"d".repeat(64)}`,
      ports: {
        serviceApi: 33001,
        adminUi: 34001,
        mqtt: 36001,
      },
      volumePrefix: "smoke-volume",
    });
    assert.equal(env.PAYMENT_MOCK_ENABLED, "false");
    assert.equal(env.SERVICE_API_PORT, "33001");
    assert.equal(env.ADMIN_UI_PORT, "34001");
    assert.equal(env.MACHINE_API_BASE_URL, "http://127.0.0.1:33001/api");
    assert.equal(env.MACHINE_MQTT_URL, "mqtt://127.0.0.1:36001");
    assert.equal(env.PAYMENT_WEBHOOK_BASE_URL, "https://payments.example");
    assert.equal(env.POSTGRES_DATA_SOURCE, "smoke-volume-postgres-data");
    assert.equal(env.MQTT_DATA_SOURCE, "smoke-volume-mqtt-data");
    assert.equal(
      env.SERVICE_API_MEDIA_VOLUME_NAME,
      "smoke-volume-service-api-media-assets",
    );
    assert.equal(env.JWT_SECRET.length, 64);
    assert.equal(env.MACHINE_JWT_SECRET.length, 64);
  });

  it("uses one Compose file and env file for the smoke command", () => {
    assert.deepEqual(
      composeCommand({
        project: "vem-backend-smoke",
        envFile: "/tmp/backend.env",
        composeFile: "/repo/apps/service-api/docker-compose.yml",
      }),
      [
        "compose",
        "-p",
        "vem-backend-smoke",
        "--env-file",
        "/tmp/backend.env",
        "-f",
        "/repo/apps/service-api/docker-compose.yml",
      ],
    );
  });

  it("uses only the host env file and static Compose file on the target host", () => {
    assert.equal(
      JSON.stringify(
        targetHostComposeCommand({
          envFile: "/etc/vem/backend.env",
          composeFile: "/opt/vem-backend/apps/service-api/docker-compose.yml",
        }),
      ),
      JSON.stringify([
        "compose",
        "--env-file",
        "/etc/vem/backend.env",
        "-f",
        "/opt/vem-backend/apps/service-api/docker-compose.yml",
      ]),
    );
  });

  it("passes every required production endpoint and key into Service API", () => {
    const compose = readFileSync(composePath, "utf8");
    for (const variable of [
      "MACHINE_API_BASE_URL",
      "MACHINE_MQTT_URL",
      "MACHINE_CLAIM_LOOKUP_HMAC_KEY",
      "PAYMENT_WEBHOOK_BASE_URL",
      "PAYMENT_CONFIG_ENCRYPTION_KEY",
    ]) {
      assert.match(compose, new RegExp(`^\\s+${variable}:`, "m"));
    }
  });

  it("declares the host-owned secrets required by the static Compose file", () => {
    const compose = readFileSync(composePath, "utf8");
    for (const variable of [
      "POSTGRES_PASSWORD",
      "MQTT_USERNAME",
      "MQTT_PASSWORD",
      "JWT_SECRET",
      "JWT_REFRESH_SECRET",
      "BOOTSTRAP_ADMIN_PASSWORD",
      "MACHINE_JWT_SECRET",
      "MACHINE_CREDENTIAL_ENCRYPTION_KEY",
      "MACHINE_CLAIM_LOOKUP_HMAC_KEY",
      "PAYMENT_WEBHOOK_BASE_URL",
      "PAYMENT_CONFIG_ENCRYPTION_KEY",
    ]) {
      assert.match(compose, new RegExp(`\\$\\{${variable}:\\?`));
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
    assert.equal(compose.services.postgres.ports, undefined);
    assert.match(
      compose.services["service-api"].image,
      /\$\{SERVICE_API_IMAGE:\?SERVICE_API_IMAGE is required\}/,
    );
    assert.match(
      compose.services["admin-ui"].image,
      /\$\{ADMIN_UI_IMAGE:\?ADMIN_UI_IMAGE is required\}/,
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
      compose.volumes["vem-postgres-data"].name,
      "${POSTGRES_DATA_SOURCE:-vem-postgres-data}",
    );
    assert.equal(
      compose.volumes["vem-mqtt-data"].name,
      "${MQTT_DATA_SOURCE:-vem-mqtt-data}",
    );
    assert.equal(
      compose.volumes["vem-service-api-media-assets"].name,
      "${SERVICE_API_MEDIA_VOLUME_NAME:-vem-service-api-media-assets}",
    );
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
        assert.match(
          rendered,
          /registry\.example\/vem-service-api@sha256:a{64}/,
        );
        assert.match(rendered, /registry\.example\/vem-admin-ui@sha256:b{64}/);
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
          /SERVICE_API_IMAGE is required/,
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects a target-host Compose env missing required secrets",
    { skip: dockerComposeSkip },
    () => {
      const temp = mkdtempSync(join(tmpdir(), "vem-backend-compose-"));
      try {
        const envPath = join(temp, "backend.env");
        const { POSTGRES_PASSWORD: _removed, ...env } = backendEnv();
        writeEnvFile(envPath, env);
        assert.throws(
          () => dockerComposeConfig(envPath),
          /POSTGRES_PASSWORD is required/,
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

  it("accepts only digest-pinned app images for deployment helpers", () => {
    assert.equal(
      validateDigestPinnedImage(
        `ghcr.io/ykdz/vem-service-api@sha256:${"e".repeat(64)}`,
        "SERVICE_API_IMAGE",
      ),
      `ghcr.io/ykdz/vem-service-api@sha256:${"e".repeat(64)}`,
    );
    assert.throws(
      () =>
        validateDigestPinnedImage(
          "ghcr.io/ykdz/vem-service-api:latest",
          "SERVICE_API_IMAGE",
        ),
      /@sha256:<64hex>/,
    );
    assert.throws(
      () =>
        validateDigestPinnedImage(
          `ghcr.io/ykdz/vem-admin-ui:sha-${commit}`,
          "ADMIN_UI_IMAGE",
        ),
      /@sha256:<64hex>/,
    );
  });

  it("accepts webhook base URLs only as origin or plural webhook base path", () => {
    assert.equal(
      validatePaymentWebhookBaseUrl("https://pay.example.com"),
      "https://pay.example.com",
    );
    assert.equal(
      validatePaymentWebhookBaseUrl(
        "https://pay.example.com/api/payments/webhooks",
      ),
      "https://pay.example.com/api/payments/webhooks",
    );
    assert.throws(
      () =>
        validatePaymentWebhookBaseUrl(
          "https://pay.example.com/api/payments/webhook",
        ),
      /service origin or \/api\/payments\/webhooks/,
    );
  });
});
