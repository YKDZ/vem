import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";

import {
  backendComposeSmokeEnv,
  composeCommand,
} from "./backend-compose-smoke.mjs";
import {
  deploy,
  deploymentRecord,
  renderDigestComposeOverride,
  renderDigestPinnedCompose,
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
  it("builds a bounded production-like Compose smoke env", () => {
    const env = backendComposeSmokeEnv({
      serviceApiImage: "registry/vem-service-api@sha256:service",
      adminUiImage: "registry/vem-admin-ui@sha256:admin",
      ports: {
        serviceApi: 33001,
        adminUi: 34001,
        postgres: 35001,
        mqtt: 36001,
      },
      volumePrefix: "smoke-volume",
    });
    assert.equal(env.PAYMENT_MOCK_ENABLED, "false");
    assert.equal(env.SERVICE_API_PORT, "33001");
    assert.equal(env.ADMIN_UI_PORT, "34001");
    assert.equal(env.MACHINE_MQTT_URL, "mqtt://127.0.0.1:36001");
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

  it("renders the digest override used by target-host compose deployment", () => {
    assert.equal(
      renderDigestComposeOverride({
        serviceApi: "registry/vem-service-api@sha256:service",
        adminUi: "registry/vem-admin-ui@sha256:admin",
      }),
      [
        "services:",
        "  service-api:",
        "    image: registry/vem-service-api@sha256:service",
        "  admin-ui:",
        "    image: registry/vem-admin-ui@sha256:admin",
        "",
      ].join("\n"),
    );
  });

  it("renders a single digest-pinned compose artifact from the runtime definition", () => {
    const rendered = renderDigestPinnedCompose(
      readFileSync(composePath, "utf8"),
      {
        serviceApi: "registry/vem-service-api@sha256:service",
        adminUi: "registry/vem-admin-ui@sha256:admin",
      },
    );
    const compose = YAML.parse(rendered);
    assert.equal(
      compose.services["service-api"].image,
      "registry/vem-service-api@sha256:service",
    );
    assert.equal(
      compose.services["admin-ui"].image,
      "registry/vem-admin-ui@sha256:admin",
    );
    assert.ok("postgres" in compose.services);
    assert.ok("mqtt" in compose.services);
    assert.ok("vem-service-api-media-assets" in compose.volumes);
  });

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
      releaseComposeFile: "/compose.release.yml",
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

  it("drives the pull-only compose deployment in digest-pinned order", async () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-backend-deploy-"));
    const calls = [];
    const outputs = [];
    const serviceImage = `registry/vem-service-api:sha-${commit}`;
    const adminImage = `registry/vem-admin-ui:sha-${commit}`;
    const fakeExec = (command, args) => {
      calls.push([command, ...args]);
      const joined = [command, ...args].join(" ");
      if (joined.endsWith(" config --images")) {
        return `${serviceImage}\n${adminImage}\n`;
      }
      if (args[0] === "inspect" && args.at(-1) === serviceImage) {
        return "registry/vem-service-api@sha256:service\n";
      }
      if (args[0] === "inspect" && args.at(-1) === adminImage) {
        return "registry/vem-admin-ui@sha256:admin\n";
      }
      if (args[0] === "compose" && args.at(-2) === "-q") {
        return `container-${args.at(-1)}\n`;
      }
      if (args[0] === "inspect" && args[3]?.startsWith("container-")) {
        return "healthy\n";
      }
      if (args[0] === "exec" && args[1] === "container-admin-ui") {
        return JSON.stringify({
          data: { database: "ok", mqtt: "connected" },
        });
      }
      if (args[0] === "compose" && args.at(-1) === "ps") return "";
      return "";
    };
    try {
      const record = await deploy(
        [
          "--commit",
          commit,
          "--env",
          join(temp, "backend.env"),
          "--compose",
          composePath.pathname,
          "--state-dir",
          temp,
        ],
        {},
        {
          execFileSync: fakeExec,
          writeFileSync: (path, content) => {
            writeFileSync(path, content);
            outputs.push([path, content]);
          },
          stdout: { write: () => undefined },
          now: () => new Date("2026-07-21T00:00:00.000Z"),
        },
      );
      assert.deepEqual(record.repoDigests, {
        serviceApi: "registry/vem-service-api@sha256:service",
        adminUi: "registry/vem-admin-ui@sha256:admin",
      });
      assert.match(
        outputs.find(([path]) => path.endsWith("digest-compose.yml"))?.[1] ??
          "",
        /registry\/vem-service-api@sha256:service/,
      );
      assert.match(
        outputs.find(([path]) => path.endsWith("compose.release.yml"))?.[1] ??
          "",
        /registry\/vem-admin-ui@sha256:admin/,
      );
      const commandLines = calls.map((call) => call.join(" "));
      assert.match(commandLines[0] ?? "", /docker compose .* pull$/);
      assert.match(commandLines[1] ?? "", /docker compose .* config --images$/);
      assert.match(commandLines[2] ?? "", /docker inspect .*service-api/);
      assert.match(commandLines[3] ?? "", /docker inspect .*admin-ui/);
      assert.ok(commandLines[4]?.includes("compose"));
      assert.ok(commandLines[4]?.endsWith("up -d --remove-orphans"));
      assert.ok(
        commandLines.some((line) => line.includes("exec container-admin-ui")),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects mutable app image tags before compose up", async () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-backend-deploy-"));
    const calls = [];
    const fakeExec = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "compose" && args.at(-2) === "config") {
        return "registry/vem-service-api:latest\nregistry/vem-admin-ui:latest\n";
      }
      return "";
    };
    try {
      await assert.rejects(
        () =>
          deploy(
            [
              "--commit",
              commit,
              "--env",
              join(temp, "backend.env"),
              "--compose",
              composePath.pathname,
              "--state-dir",
              temp,
            ],
            {},
            { execFileSync: fakeExec },
          ),
        /image must use sha-/,
      );
      assert.equal(
        calls.some((call) => call.join(" ").includes("up -d")),
        false,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
