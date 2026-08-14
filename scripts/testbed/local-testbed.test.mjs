import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

import { mockPaymentCreateGatePaths } from "./host-serial-control-plane.mjs";
import {
  baselinePublicationLayout,
  publishVerifiedBaselineRelease,
  runtimeProfileForPublishedRelease,
} from "./kvm-baseline/linux-kvm-baseline.mjs";
import {
  buildBackendComposeCommand,
  buildBackendAcceptanceIdentity,
  buildBackendComposeEnvironment,
  buildComposeServiceApiEnvironment,
  buildHeadlessVncActivatorUnitPlan,
  buildHostLocalServiceApiEnvironment,
  buildMigrationEnvironment,
  buildHostControlPlaneUnitPlan,
  buildRefreshHostRuntimePlan,
  buildReconstructionPlan,
  renderBackendComposeEnv,
  renderBackendComposeOverride,
  buildServiceApiComposePlan,
  ensureLowerControllerSimCached,
  interpretServiceApiJournalCapture,
  lowerControllerSimCacheLayout,
  lowerControllerSimSourceFingerprint,
  parseOptions,
  paymentMockCreateGatePaths,
  paymentMockQueryFaultPaths,
  prepareInstallationOwnedPaymentProvider,
  reprepareGuestInputForRefresh,
  refreshPlatformFixtureForRun,
  refreshGuestInputForRun,
  seedThroughSupportedApis,
  validateRefreshGuestInput,
  validateBaselineContract,
} from "./local-testbed.mjs";

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function contract(root) {
  const hostScript = "{repository}/scripts/testbed/local-testbed-host.mjs";
  const commonHostArguments = [
    "--run-id",
    "{runId}",
    "--libvirt-uri",
    "qemu:///system",
    "--domain-name",
    "win10-runtime-testbed",
    "--overlay",
    join(root, "runtime", "system-overlay.qcow2"),
    "--runtime-xml",
    join(root, "runtime", "domain.xml"),
    "--filter-name",
    "vem-runtime-testbed-admission",
    "--filter-xml",
    join(root, "runtime", "admission-filter.xml"),
    "--host-private-cidr",
    "{hostPrivateAddress}/32",
    "--ssh-host",
    "{guestHost}",
    "--ssh-port",
    "22",
    "--ssh-user",
    "{guestUser}",
    "--identity-file",
    "{identityFile}",
    "--known-hosts-file",
    "{knownHostsFile}",
    "--readiness-timeout-seconds",
    "120",
  ];
  return {
    schemaVersion: "win10-kvm-baseline-current/v1",
    releaseId: "release-testbed-0001",
    destinations: {
      baselinePath: join(root, "baseline.qcow2"),
      cacheDiskPath: join(root, "cache.qcow2"),
    },
    artifacts: {
      systemPath: join(root, "release", "system.qcow2"),
      cachePath: join(root, "release", "cache.qcow2"),
      domainXmlPath: join(root, "release", "runtime-profile.xml"),
      diagnosticPath: join(root, "release", "diagnostic.json"),
    },
    testbed: {
      reconstructCommand: [
        "/usr/bin/node",
        hostScript,
        "reconstruct",
        ...commonHostArguments,
        "--baseline-system",
        "{systemPath}",
        "--cache-disk",
        "{cachePath}",
        "--domain-xml",
        "{domainXmlPath}",
      ],
      admitGuestCommand: [
        "/usr/bin/node",
        hostScript,
        "admit",
        ...commonHostArguments,
        "--guest-input",
        "{guestStagingPath}",
      ],
      guest: {
        host: "win10-testbed.local",
        user: "VEMKiosk",
        identityFile: join(root, "id_ed25519"),
        knownHostsFile: join(root, "known_hosts"),
        stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        cacheRoot: "D:\\runtime-cache\\v1",
      },
    },
  };
}

function options(root, mode = "full") {
  return parseOptions([
    "reconstruct",
    "--mode",
    mode,
    "--run-id",
    "run-15",
    "--workspace",
    root,
    "--state-root",
    join(root, "state"),
    "--baseline-contract",
    join(root, "baseline.json"),
    "--host-private-address",
    "10.0.0.15",
    "--out",
    join(root, "out.json"),
  ]);
}

function producerConfig(root) {
  const hostScript = "{repository}/scripts/testbed/local-testbed-host.mjs";
  const commonHostArguments = [
    "--run-id",
    "{runId}",
    "--libvirt-uri",
    "qemu:///system",
    "--domain-name",
    "win10-runtime-testbed",
    "--overlay",
    join(root, "runtime", "system-overlay.qcow2"),
    "--runtime-xml",
    join(root, "runtime", "domain.xml"),
    "--filter-name",
    "vem-runtime-testbed-admission",
    "--filter-xml",
    join(root, "runtime", "admission-filter.xml"),
    "--host-private-cidr",
    "{hostPrivateAddress}/32",
    "--ssh-host",
    "{guestHost}",
    "--ssh-port",
    "22",
    "--ssh-user",
    "{guestUser}",
    "--identity-file",
    "{identityFile}",
    "--known-hosts-file",
    "{knownHostsFile}",
    "--readiness-timeout-seconds",
    "120",
  ];
  return {
    schemaVersion: "win10-kvm-baseline/v1",
    host: {
      address: "kvm-builder.example.test",
      libvirtUri: "qemu:///system",
      lockPath: join(root, "locks", "vem-windows-runtime-testbed.lock"),
      largeFileRoot: root,
    },
    vm: {
      name: "win10-runtime-baseline",
      networkName: "runtime-testbed",
      macAddress: "52:54:00:12:34:56",
    },
    storage: {
      baselinePath: join(root, "images", "win10-runtime-baseline.qcow2"),
      cacheDiskPath: join(root, "images", "win10-runtime-cache.qcow2"),
      systemDiskGiB: 96,
      cacheDiskGiB: 160,
      minimumFreeGiB: 80,
    },
    media: {
      windowsIsoPath: join(root, "media", "windows-10.iso"),
      virtioWinIsoPath: join(root, "media", "virtio-win.iso"),
      windowsImageIndex: 1,
      runnerArchivePath: join(root, "media", "actions-runner-win-x64.zip"),
      runnerArchiveSha256: "a".repeat(64),
      webView2InstallerUri: "https://downloads.example.test/webview2.exe",
    },
    guest: {
      administratorPasswordFile: join(
        root,
        "secrets",
        "administrator-password",
      ),
      authorizedKeysFile: join(
        root,
        "secrets",
        "administrator-authorized-keys",
      ),
      sshPrivateKeyFile: join(root, "secrets", "administrator-private-key"),
      sshUser: "VEMKiosk",
      desktopScalePercent: 100,
    },
    runner: {
      url: "https://github.com/example/runtime",
      labels: ["self-hosted", "Windows", "X64", "vem-runtime"],
      registrationTokenProvider: {
        command: join(root, "bin", "issue-runner-token"),
        arguments: ["--repository", "example/runtime"],
      },
      name: "win10-runtime-baseline-runner",
    },
    testbed: {
      reconstructCommand: [
        "/usr/bin/node",
        hostScript,
        "reconstruct",
        ...commonHostArguments,
        "--baseline-system",
        "{systemPath}",
        "--cache-disk",
        "{cachePath}",
        "--domain-xml",
        "{domainXmlPath}",
      ],
      admitGuestCommand: [
        "/usr/bin/node",
        hostScript,
        "admit",
        ...commonHostArguments,
        "--guest-input",
        "{guestStagingPath}",
      ],
      guest: {
        host: "win10-testbed.local",
        user: "VEMKiosk",
        identityFile: join(root, "secrets", "administrator-private-key"),
        knownHostsFile: join(root, "ssh", "known_hosts"),
        stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        cacheRoot: "D:\\runtime-cache\\v1",
      },
    },
  };
}

async function publishCurrentManifest(root) {
  const config = producerConfig(root);
  const stagedSystemDirectory = join(root, "staging", "system");
  const stagedCacheDirectory = join(root, "staging", "cache");
  mkdirSync(stagedSystemDirectory, { recursive: true });
  mkdirSync(stagedCacheDirectory, { recursive: true });
  writeFileSync(join(stagedSystemDirectory, "system.qcow2"), "system", {
    flag: "w",
  });
  writeFileSync(join(stagedCacheDirectory, "cache.qcow2"), "cache", {
    flag: "w",
  });
  writeFileSync(
    join(stagedSystemDirectory, "runtime-profile.xml"),
    "<domain>runtime</domain>",
    { flag: "w" },
  );
  writeFileSync(
    join(stagedSystemDirectory, "diagnostic.json"),
    JSON.stringify({ status: "ok" }),
    { flag: "w" },
  );
  await publishVerifiedBaselineRelease({
    config,
    releaseId: "release-local-testbed-0001",
    stagedSystemPath: join(stagedSystemDirectory, "system.qcow2"),
    stagedCachePath: join(stagedCacheDirectory, "cache.qcow2"),
    stagedDomainXmlPath: join(stagedSystemDirectory, "runtime-profile.xml"),
    stagedDiagnosticPath: join(stagedSystemDirectory, "diagnostic.json"),
    profile: runtimeProfileForPublishedRelease(
      config,
      "release-local-testbed-0001",
    ),
    verified: true,
    commitDefinition: async () => {},
    rollbackDefinition: async () => {},
  });
  return JSON.parse(
    readFileSync(baselinePublicationLayout(config).currentManifestPath, "utf8"),
  );
}

describe("local testbed orchestration", () => {
  it("imports the installation-owned Alipay fixture on the host without returning secrets", async () => {
    const calls = [];
    const prepared = await prepareInstallationOwnedPaymentProvider({
      baseUrl: "http://127.0.0.1:26849/api",
      fixturePath: "/srv/vem/alipay-sandbox.fixture.json",
      readFixture: async () => ({
        schemaVersion: "vem-installation-alipay-sandbox-fixture/v1",
        ownership: "host-installation",
        target: "local-service-api",
        providerConfig: {
          providerCode: "alipay",
          appId: "9021000163629927",
          merchantNo: "2088721101045878",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
            keyType: "PKCS1",
          },
          sensitiveConfigJson: { privateKeyPem: "host-only" },
        },
        channelPolicy: {
          channels: [
            { channelKey: "qr_code:alipay", enabled: true },
            { channelKey: "payment_code:alipay", enabled: true },
          ],
        },
      }),
      request: async (_baseUrl, path, options = {}) => {
        calls.push({ path, body: options.body });
        if (path === "/auth/login") return { accessToken: "host-token" };
        if (path === "/payments/providers") {
          return [{ id: "provider-alipay", code: "alipay" }];
        }
        if (
          path === "/payments/provider-configs" &&
          options.method === "POST"
        ) {
          return { id: "config-1" };
        }
        if (path === "/payments/provider-configs") {
          return [
            {
              id: "config-1",
              providerCode: "alipay",
              publicConfigJson: {
                mode: "sandbox",
                gatewayUrl:
                  "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
                keyType: "PKCS1",
              },
            },
          ];
        }
        return {};
      },
    });
    assert.deepEqual(prepared, {
      identity: {
        providerCode: "alipay",
        providerConfigId: "config-1",
        appId: "9021000163629927",
        merchantNo: "2088721101045878",
        mode: "sandbox",
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS1",
      },
      hostPreparation: {
        source: "host_installation_fixture",
        preflight: "configured",
      },
    });
    assert.deepEqual(calls[2], {
      path: "/payments/providers/provider-alipay",
      body: { status: "enabled" },
    });
    assert.equal(calls[3].body.sensitiveConfigJson.privateKeyPem, "host-only");
    assert.equal(JSON.stringify(prepared).includes("host-only"), false);
  });
  it("plans a non-destructive host runtime refresh from the committed workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = parseOptions([
        "refresh-host-runtime",
        "--workspace",
        root,
        "--state-root",
        join(root, "state"),
        "--run-id",
        "RUN-CURRENT-FAST",
        "--baseline-contract",
        join(root, "baseline.json"),
        "--host-private-address",
        "10.0.0.15",
        "--out",
        join(root, "refresh.json"),
      ]);
      assert.equal(parsedOptions.command, "refresh-host-runtime");
      assert.equal(parsedOptions.runId, "RUN-CURRENT-FAST");
      assert.equal("mode" in parsedOptions, false);
      const rendered = buildRefreshHostRuntimePlan(parsedOptions)
        .map((step) => `${step.command} ${step.args.join(" ")}`)
        .join("\n");
      assert.match(
        rendered,
        /docker compose .*apps\/service-api\/docker-compose\.yml .*backend\.compose\.override\.yml .* up -d postgres mqtt/,
      );
      assert.match(
        rendered,
        /pnpm turbo build --filter @vem\/shared --filter @vem\/db --filter service-api/,
      );
      assert.match(rendered, /pnpm --filter @vem\/db migrate/);
      assert.doesNotMatch(rendered, /docker rm|volume|reconstruct|seed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives local backend runtime from the static backend Compose file", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = options(root);
      const command = buildBackendComposeCommand(parsedOptions, [
        "up",
        "-d",
        "postgres",
        "mqtt",
      ]);
      const rendered = `${command.command} ${command.args.join(" ")}`;
      const composeEnv = buildBackendComposeEnvironment(parsedOptions);
      const serviceEnv = buildHostLocalServiceApiEnvironment(parsedOptions);
      assert.match(
        rendered,
        /docker compose --env-file .*backend\.compose\.env -f .*apps\/service-api\/docker-compose\.yml -f .*backend\.compose\.override\.yml -p vem-local-testbed up -d postgres mqtt/,
      );
      assert.equal(composeEnv.POSTGRES_DB, "vem_local_testbed");
      assert.equal(
        composeEnv.POSTGRES_DATA_SOURCE,
        "vem-local-testbed-postgres-data",
      );
      assert.equal(
        composeEnv.MQTT_DATA_SOURCE,
        "vem-local-testbed-mosquitto-data",
      );
      assert.equal(serviceEnv.MQTT_USERNAME, composeEnv.MQTT_USERNAME);
      assert.equal(serviceEnv.MQTT_PASSWORD, composeEnv.MQTT_PASSWORD);
      assert.match(renderBackendComposeEnv(parsedOptions), /^POSTGRES_DB=/m);
      const override = renderBackendComposeOverride(parsedOptions);
      const parsedOverride = parseYaml(override);
      const composeServiceEnv =
        buildComposeServiceApiEnvironment(parsedOptions);
      assert.match(override, /container_name: vem-local-testbed-mosquitto/);
      assert.match(override, /service-api:/);
      assert.match(override, /image: node:24-bookworm-slim/);
      assert.deepEqual(parsedOverride.services["service-api"].volumes, [
        `${root}:/workspace`,
        `${join(root, "state")}:/testbed-state`,
      ]);
      assert.equal(
        composeServiceEnv.DATABASE_URL,
        "postgresql://vem:vem_local_testbed_password@postgres:5432/vem_local_testbed",
      );
      assert.equal(composeServiceEnv.MQTT_URL, "mqtt://mqtt:1883");
      assert.equal(composeServiceEnv.SERVICE_PORT, "3000");
      assert.equal(
        composeServiceEnv.MACHINE_API_BASE_URL,
        "http://10.0.0.15:26849/api",
      );
      assert.equal(
        composeServiceEnv.PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH,
        "/testbed-state/fast-route/mock-payment-create-gate.json",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes the per-run guest identity and host-preflighted provider identity", () => {
    const previous = {
      runId: "RUN-PREVIOUS-FULL",
      machineCode: "VEM-TESTBED-LOCAL",
      claimCode: "ABCD-EFGH",
      fixtureAllocation: { sale: { slotDisplayLabel: "A1" } },
      hostControlPlane: { token: "retained-token" },
      paymentProvider: {
        identity: { providerCode: "alipay", providerConfigId: "stale-config" },
        hostPreparation: {
          source: "host_installation_fixture",
          preflight: "configured",
        },
      },
    };
    const paymentProvider = {
      identity: { providerCode: "alipay", providerConfigId: "fresh-config" },
      hostPreparation: {
        source: "host_installation_fixture",
        preflight: "configured",
      },
    };
    assert.deepEqual(
      refreshGuestInputForRun(previous, "RUN-CURRENT-FAST", paymentProvider),
      {
        ...previous,
        runId: "RUN-CURRENT-FAST",
        paymentProvider,
      },
    );
  });

  it("reimports the host-owned payment fixture before refreshing guest identity", async () => {
    const preparePaymentProvider = async ({ baseUrl }) => {
      assert.equal(baseUrl, "http://127.0.0.1:26849/api");
      return {
        identity: { providerCode: "alipay", providerConfigId: "fresh-config" },
        hostPreparation: {
          source: "host_installation_fixture",
          preflight: "configured",
        },
      };
    };
    const refreshed = await reprepareGuestInputForRefresh({
      input: {
        runId: "RUN-PREVIOUS-FULL",
        paymentProvider: {
          identity: {
            providerCode: "alipay",
            providerConfigId: "stale-config",
          },
        },
      },
      runId: "RUN-CURRENT-FAST",
      baseUrl: "http://127.0.0.1:26849/api",
      preparePaymentProvider,
    });
    assert.equal(refreshed.runId, "RUN-CURRENT-FAST");
    assert.equal(
      refreshed.paymentProvider.identity.providerConfigId,
      "fresh-config",
    );
  });

  it("reseeds the platform fixture when a fast refresh finds no current machine", async () => {
    const input = {
      runId: "RUN-PREVIOUS",
      machineCode: "VEM-TESTBED-LOCAL",
      claimCode: "OLD-0001",
      fixtureAllocation: { sale: { slotDisplayLabel: "A1" } },
      visionAcceptance: { selectedCatalogKey: "old" },
    };
    const calls = [];
    const refreshed = await refreshPlatformFixtureForRun({
      input,
      baseUrl: "http://127.0.0.1:26849/api",
      fixture: { schemaVersion: "fixture" },
      hostPrivateAddress: "10.0.0.15",
      request: async (_base, path, options = {}) => {
        calls.push({ path, ...options });
        if (path === "/auth/login") return { accessToken: "admin-token" };
        if (path === "/machines?page=1&pageSize=100") return { items: [] };
        throw new Error(`unexpected request: ${path}`);
      },
      seedPlatform: async ({ baseUrl, hostPrivateAddress }) => {
        assert.equal(baseUrl, "http://127.0.0.1:26849/api");
        assert.equal(hostPrivateAddress, "10.0.0.15");
        return {
          machine: { code: "VEM-TESTBED-LOCAL" },
          claim: { claimCode: "NEW-0001" },
          planogramVersion: "LOCAL-TESTBED-V2",
          visionAcceptance: { selectedCatalogKey: "new" },
          slots: [
            {
              slotId: "slot-sale",
              rowNo: 1,
              cellNo: 1,
              slotDisplayLabel: "A1",
              categoryKey: "socks",
              inventoryId: "inventory-sale",
              onHandQty: 3,
              sku: "SKU-SALE",
            },
            {
              slotId: "slot-scanner",
              rowNo: 1,
              cellNo: 2,
              slotDisplayLabel: "A2",
              categoryKey: "socks",
              inventoryId: "inventory-scanner",
              onHandQty: 3,
              sku: "SKU-SCANNER",
            },
            {
              slotId: "slot-vision",
              rowNo: 1,
              cellNo: 3,
              slotDisplayLabel: "A3",
              categoryKey: "tshirts",
              inventoryId: "inventory-vision",
              onHandQty: 3,
              sku: "SKU-VISION",
            },
            {
              slotId: "slot-failure",
              rowNo: 1,
              cellNo: 4,
              slotDisplayLabel: "A4",
              categoryKey: "socks",
              inventoryId: "inventory-failure",
              onHandQty: 3,
              sku: "SKU-FAILURE",
            },
            {
              slotId: "slot-pickup",
              rowNo: 1,
              cellNo: 5,
              slotDisplayLabel: "A5",
              categoryKey: "socks",
              inventoryId: "inventory-pickup",
              onHandQty: 3,
              sku: "SKU-PICKUP",
            },
            {
              slotId: "slot-ipc",
              rowNo: 2,
              cellNo: 1,
              slotDisplayLabel: "B1",
              categoryKey: "socks",
              inventoryId: "inventory-ipc",
              onHandQty: 3,
              sku: "SKU-IPC",
            },
            {
              slotId: "slot-stock",
              rowNo: 2,
              cellNo: 2,
              slotDisplayLabel: "B2",
              categoryKey: "socks",
              inventoryId: "inventory-stock",
              onHandQty: 1,
              sku: "SKU-STOCK",
            },
            {
              slotId: "slot-ai-try-on",
              rowNo: 2,
              cellNo: 5,
              slotDisplayLabel: "B5",
              categoryKey: "tshirts",
              inventoryId: "inventory-ai-try-on",
              onHandQty: 3,
              sku: "SKU-AI-TRY-ON",
            },
          ],
        };
      },
    });
    assert.equal(calls.at(0).path, "/auth/login");
    assert.equal(refreshed.claimCode, "NEW-0001");
    assert.equal(refreshed.planogramVersion, "LOCAL-TESTBED-V2");
    assert.equal(refreshed.visionAcceptance.selectedCatalogKey, "new");
    assert.equal(
      refreshed.fixtureAllocation.stockMaintenance.slotId,
      "slot-stock",
    );
    assert.equal(Object.keys(refreshed.fixtureAllocation).length, 8);
    assert.equal(
      refreshed.fixtureAllocation.aiVirtualTryOn.slotId,
      "slot-ai-try-on",
    );
  });

  it("keeps the refresh fixture when the current machine is still present", async () => {
    const input = {
      machineCode: "VEM-TESTBED-LOCAL",
      claimCode: "OLD-0001",
      fixtureAllocation: { sale: { slotDisplayLabel: "A1" } },
    };
    const refreshed = await refreshPlatformFixtureForRun({
      input,
      baseUrl: "http://127.0.0.1:26849/api",
      fixture: { schemaVersion: "fixture" },
      hostPrivateAddress: "10.0.0.15",
      request: async (_base, path) => {
        if (path === "/auth/login") return { accessToken: "admin-token" };
        if (path === "/machines?page=1&pageSize=100")
          return { items: [{ code: "VEM-TESTBED-LOCAL" }] };
        throw new Error(`unexpected request: ${path}`);
      },
      seedPlatform: async () => {
        throw new Error("seed should not run when the machine is present");
      },
    });
    assert.equal(refreshed, input);
  });

  it("requires refresh to retain the existing guest identity and control-plane token", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = {
        hostPrivateAddress: "10.0.0.15",
      };
      const guestInput = {
        schemaVersion: "vem-local-testbed-guest-input/v1",
        machineCode: "VEM-TESTBED-LOCAL",
        claimCode: "ABCD-EFGH",
        fixtureIdentity: {
          schemaVersion: "vem-local-testbed-fixture/v1",
          sha256: "sha256:current-fixture",
        },
        fixtureAllocation: { sale: { slotDisplayLabel: "A1" } },
        hostControlPlane: {
          endpoint: "http://10.0.0.15:26851",
          token: "retained-host-control-plane-token",
        },
      };
      assert.equal(
        validateRefreshGuestInput(guestInput, parsedOptions, {
          schemaVersion: "vem-local-testbed-fixture/v1",
          sha256: "sha256:current-fixture",
        }),
        guestInput,
      );
      assert.throws(
        () =>
          validateRefreshGuestInput(guestInput, parsedOptions, {
            schemaVersion: "vem-local-testbed-fixture/v1",
            sha256: "sha256:new-fixture",
          }),
        /fixture identity is stale/,
      );
      assert.throws(
        () =>
          validateRefreshGuestInput(
            {
              ...guestInput,
              hostControlPlane: { ...guestInput.hostControlPlane, token: "" },
            },
            parsedOptions,
          ),
        /retain machine, claim, fixture, and host control plane token/,
      );
      assert.throws(
        () =>
          validateRefreshGuestInput(
            {
              ...guestInput,
              hostControlPlane: {
                ...guestInput.hostControlPlane,
                endpoint: "http:\/\/10.0.0.16:26851",
              },
            },
            parsedOptions,
          ),
        /endpoint is invalid/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for PostgreSQL before running schema migration", () => {
    const source = readFileSync(
      new URL("./local-testbed.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /run\(plan\[3\]\.command, plan\[3\]\.args[\s\S]*waitForPostgres\(\)[\s\S]*plan\.slice\(4, 6\)/,
    );
  });

  it("waits for PostgreSQL before refresh migrations and avoids transient readiness", () => {
    const source = readFileSync(
      new URL("./local-testbed.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /await run\(plan\[0\]\.command, plan\[0\]\.args[\s\S]*await waitForPostgres\(\)[\s\S]*plan\.slice\(1\)/,
    );
    assert.match(source, /consecutiveReadyChecks >= 2/);
  });

  it("requires the generic baseline contract to separate reconstruction from guest admission", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      assert.deepEqual(validateBaselineContract(value), value);
      assert.throws(
        () =>
          validateBaselineContract({
            ...value,
            testbed: {
              ...value.testbed,
              guest: { ...value.testbed.guest, user: "VEMRunner" },
            },
          }),
        /production machine user VEMKiosk/,
      );
      assert.throws(
        () =>
          validateBaselineContract({
            ...value,
            schemaVersion: "vem-local-testbed-baseline/v1",
          }),
        /published win10-kvm-baseline-current\/v1/,
      );
      delete value.artifacts.domainXmlPath;
      assert.throws(() => validateBaselineContract(value), /domainXmlPath/);
      value.artifacts.domainXmlPath = join(
        root,
        "release",
        "runtime-profile.xml",
      );
      value.testbed.guest.stagingPath = "ProgramData\\VEM\\guest-input.json";
      assert.throws(() => validateBaselineContract(value), /stagingPath/);
      value.testbed.guest.stagingPath =
        "C:\\ProgramData\\VEM\\testbed\\guest-input.json";
      value.testbed.reconstructCommand[0] = "node";
      assert.throws(
        () => validateBaselineContract(value),
        /reconstructCommand/,
      );
      value.testbed.reconstructCommand[0] = "/usr/bin/node";
      value.testbed.reconstructCommand[1] = "/opt/vem/opaque-wrapper";
      assert.throws(
        () => validateBaselineContract(value),
        /tracked local-testbed-host\.mjs reconstruct/,
      );
      value.testbed.reconstructCommand[1] =
        "{repository}/scripts/testbed/local-testbed-host.mjs";
      delete value.testbed.admitGuestCommand;
      assert.throws(() => validateBaselineContract(value), /admitGuestCommand/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consumes the producer-published current manifest instead of a hand-crafted duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-producer-"));
    try {
      const current = await publishCurrentManifest(root);
      writeFileSync(join(root, "baseline.json"), JSON.stringify(current));
      assert.deepEqual(validateBaselineContract(current), current);
      const plan = buildReconstructionPlan(options(root), current);
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      assert.ok(
        rendered.some((step) =>
          step.includes("local-testbed-host.mjs reconstruct"),
        ),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes("apps/service-api/docker-compose.yml"),
        ) &&
          rendered.some((step) => step.includes("up -d postgres mqtt")) &&
          rendered.some((step) =>
            step.includes("local-testbed-host.mjs admit"),
          ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the current Node runtime when the published baseline Node path is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-node-"));
    try {
      const current = await publishCurrentManifest(root);
      current.testbed.reconstructCommand[0] = join(root, "missing", "node");
      current.testbed.admitGuestCommand[0] = join(root, "missing", "node");
      assert.deepEqual(validateBaselineContract(current), current);

      const plan = buildReconstructionPlan(options(root), current);
      assert.equal(plan[2].command, process.execPath);
      assert.equal(plan.at(-1).command, process.execPath);
      assert.equal(
        plan[2].args[0],
        join(root, "scripts/testbed/local-testbed-host.mjs"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs host-local Service API through the same Compose backend lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = options(root);
      const plan = buildServiceApiComposePlan(parsedOptions);
      const serviceEnvironment =
        buildHostLocalServiceApiEnvironment(parsedOptions);
      const migrationEnvironment = buildMigrationEnvironment(parsedOptions, {
        baseEnvironment: { PATH: "/usr/bin", HOME: root, USER: "tester" },
      });
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      assert.match(rendered[0], /docker compose .* rm -sf service-api/);
      assert.match(
        rendered.at(-1),
        /docker compose .* up -d --force-recreate service-api/,
      );
      for (const [name, value] of Object.entries(serviceEnvironment)) {
        assert.equal(migrationEnvironment[name], value);
      }
      assert.equal(
        migrationEnvironment.DOTENV_CONFIG_PATH,
        join(root, "state", "service-api.local-testbed.env"),
      );
      assert.equal(
        serviceEnvironment.PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH,
        paymentMockCreateGatePaths(parsedOptions.stateRoot).statePath,
      );
      assert.doesNotMatch(
        JSON.stringify({ serviceEnvironment, migrationEnvironment }),
        /admin-ui|5173|118\.25\.|192\.168\.|VPS/i,
      );
      const implementation = readFileSync(
        new URL("./local-testbed.mjs", import.meta.url),
        "utf8",
      );
      assert.match(
        implementation,
        /logs"[\s\S]*"--tail"[\s\S]*"200"[\s\S]*"service-api"/,
      );
      assert.doesNotMatch(
        implementation,
        /systemd-run --unit=vem-local-testbed-service-api|service-api\.pid|detached: true/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds real Service API health and an observed Admin UI HTTP delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-testbed-backend-identity-"));
    try {
      mkdirSync(join(root, "apps/service-api/dist"), { recursive: true });
      mkdirSync(join(root, "apps/admin-ui/dist/assets"), { recursive: true });
      writeFileSync(join(root, "apps/service-api/dist/main.js"), "service\n");
      writeFileSync(join(root, "apps/admin-ui/dist/index.html"), "admin\n");
      writeFileSync(join(root, "apps/admin-ui/dist/assets/app.js"), "ui\n");
      const first = await buildBackendAcceptanceIdentity(root, {
        database: "ok",
        mqtt: "connected",
      });
      const second = await buildBackendAcceptanceIdentity(root, {
        database: "ok",
        mqtt: "connected",
      });
      assert.deepEqual(first, second);
      assert.deepEqual(first.serviceApi.runtime, {
        database: "ok",
        entrypoint: "main.js",
        health: "ready",
        mqtt: "connected",
      });
      assert.equal(first.serviceApi.build.fileCount, 1);
      assert.equal(first.adminUi.build.fileCount, 2);
      assert.deepEqual(first.adminUi.delivery, {
        entrypoint: "index.html",
        observedHttp: {
          byteSize: 6,
          method: "GET",
          responseSha256: createHash("sha256").update("admin\n").digest("hex"),
          status: 200,
        },
      });
      assert.match(first.adminUi.build.sha256, /^[a-f0-9]{64}$/);
      const plan = buildReconstructionPlan(
        options(root),
        await publishCurrentManifest(root),
      );
      assert.ok(
        plan.flatMap((step) => step.args).includes("--filter=admin-ui"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes initialized mock create and query testbed boundaries for service-api", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = options(root);
      const environment = buildHostLocalServiceApiEnvironment(parsedOptions);
      const gate = paymentMockCreateGatePaths(parsedOptions.stateRoot);
      const queryFault = paymentMockQueryFaultPaths(parsedOptions.stateRoot);
      assert.equal(
        environment.PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH,
        gate.statePath,
      );
      assert.deepEqual(
        mockPaymentCreateGatePaths(parsedOptions.stateRoot),
        gate,
      );
      assert.match(
        gate.pendingPath,
        /mock-payment-create-gate\.json\.pending\.json$/,
      );
      assert.equal(
        environment.PAYMENT_MOCK_PROVIDER_QUERY_FAULT_PATH,
        queryFault.statePath,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Service API log capture exits non-zero and only exposes bounded stdout as platform log", () => {
    const bounded = interpretServiceApiJournalCapture({
      ok: true,
      stdout: `stderr-looking-line\n${"x".repeat(20_000)}`,
    });
    assert.deepEqual(bounded.kind, "journal");
    assert.equal(bounded.text.length, 16_000);

    const unavailable = interpretServiceApiJournalCapture({
      ok: false,
      error: "docker compose logs exited with 1: permission denied",
    });
    assert.deepEqual(unavailable, {
      kind: "unavailable",
      text: "docker compose logs exited with 1: permission denied",
    });
  });

  it("starts a persistent Linux host control plane and publishes its guest-facing endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      const adapterRelativePath =
        "scripts/testbed/qemu-usb-serial-host-adapter.mjs";
      mkdirSync(join(root, "scripts/testbed"), { recursive: true });
      writeFileSync(
        join(root, adapterRelativePath),
        readFileSync(
          new URL(`./qemu-usb-serial-host-adapter.mjs`, import.meta.url),
        ),
      );
      const plan = buildHostControlPlaneUnitPlan(options(root), value);
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      assert.match(
        rendered.at(-1),
        /systemd-run --unit=vem-local-testbed-host-control-plane --collect/,
      );
      assert.match(
        rendered.at(-1),
        /scripts\/testbed\/host-serial-control-plane\.mjs/,
      );
      const adapterPath = join(
        root,
        "scripts/testbed/qemu-usb-serial-host-adapter.mjs",
      );
      const adapterSha256 = createHash("sha256")
        .update(readFileSync(adapterPath))
        .digest("hex");
      assert.match(
        rendered.at(-1),
        new RegExp(
          `--setenv=VEM_VM_HOST_ADAPTER=${adapterPath.replaceAll("/", "\\/")}`,
        ),
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_VERSION=1\.0\.0/,
      );
      assert.match(
        rendered.at(-1),
        new RegExp(
          `--setenv=VEM_VM_HOST_ADAPTER_SHA256=sha256:${adapterSha256}`,
        ),
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_DOMAIN=win10-runtime-testbed/,
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_STATE_ROOT=.*host-adapter/,
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_LOCAL_TESTBED_MQTT_USERNAME=vem_local_testbed_mqtt/,
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_LOCAL_TESTBED_MQTT_PASSWORD=vem_local_testbed_mqtt_password/,
      );
      assert.match(rendered.at(-1), /--libvirt-uri qemu:\/\/\/system/);
      assert.match(rendered.at(-1), /--domain-name win10-runtime-testbed/);
      const retainedTokenPlan = buildHostControlPlaneUnitPlan(
        options(root),
        value,
        { token: "retained-host-control-plane-token" },
      );
      assert.ok(
        retainedTokenPlan
          .at(-1)
          .args.includes("retained-host-control-plane-token"),
      );
      assert.doesNotMatch(rendered.at(-1), /fake-vm-host-adapter/);
      const implementation = readFileSync(
        new URL("./local-testbed.mjs", import.meta.url),
        "utf8",
      );
      assert.match(implementation, /hostControlPlane:/);
      assert.doesNotMatch(
        implementation,
        /fastSale:\s*\{[\s\S]*createOrderGate/s,
      );
      assert.match(implementation, /targetIdentity:/);
      assert.match(implementation, /runtimeBaseIdentity:/);
      assert.match(implementation, /26851/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the persistent headless VNC activator unit around the tracked host script", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const plan = buildHeadlessVncActivatorUnitPlan(
        options(root),
        contract(root),
      );
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      assert.match(
        rendered.at(-1),
        /local-testbed-host\.mjs headless-vnc-activator/,
      );
      assert.match(
        rendered.at(-1),
        /--unit=vem-local-testbed-headless-vnc-activator/,
      );
      assert.match(rendered.at(-1), /--libvirt-uri qemu:\/\/\/system/);
      assert.match(rendered.at(-1), /--domain-name win10-runtime-testbed/);
      assert.match(
        rendered.at(-1),
        new RegExp(
          `--state-root ${join(root, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces fixed host state and C overlay before admitting the Windows guest", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      writeFileSync(join(root, "baseline.json"), JSON.stringify(value));
      const plan = buildReconstructionPlan(options(root), value);
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      const migrateStep = plan.find(
        (step) =>
          step.command === "pnpm" &&
          step.args.join(" ") === "--filter @vem/db migrate",
      );
      const resetIndex = rendered.findIndex((step) =>
        step.includes("local-testbed-host.mjs reconstruct"),
      );
      const cleanupIndex = rendered.findIndex((step) =>
        step.includes("docker rm -f vem-local-testbed-postgres"),
      );
      const postgresIndex = rendered.findIndex((step) =>
        step.includes("up -d postgres mqtt"),
      );
      const admissionIndex = rendered.findIndex((step) =>
        step.includes("local-testbed-host.mjs admit"),
      );
      assert.ok(
        rendered.some((step) => step.includes("docker compose --env-file")),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes("down --remove-orphans --volumes"),
        ),
      );
      assert.ok(
        cleanupIndex >= 0 &&
          rendered[cleanupIndex].includes(
            "docker volume rm -f vem-local-testbed-postgres-data",
          ),
      );
      assert.ok(
        cleanupIndex < resetIndex &&
          resetIndex < postgresIndex &&
          postgresIndex < admissionIndex,
      );
      assert.ok(rendered.some((step) => step.includes("guest-input.json")));
      assert.equal(
        rendered.some((step) =>
          step.includes("cargo build -p lower-controller-sim --locked"),
        ),
        false,
      );
      assert.match(
        rendered[resetIndex],
        new RegExp(value.artifacts.systemPath),
      );
      assert.match(rendered[resetIndex], new RegExp(value.artifacts.cachePath));
      assert.match(
        rendered[admissionIndex],
        /--guest-input C:\\ProgramData\\VEM\\testbed\\guest-input\.json/,
      );
      assert.ok(migrateStep?.env);
      assert.equal(
        migrateStep.env.DATABASE_URL,
        buildHostLocalServiceApiEnvironment(options(root)).DATABASE_URL,
      );
      assert.equal(
        migrateStep.env.DOTENV_CONFIG_PATH,
        join(root, "state", "service-api.local-testbed.env"),
      );
      const implementation = readFileSync(
        new URL("./local-testbed.mjs", import.meta.url),
        "utf8",
      );
      assert.match(implementation, /interactiveUser:\s*"VEMKiosk"/);
      assert.match(implementation, /installed-runtime-handoff\.json/);
      assert.match(
        implementation,
        /await stopHeadlessVncActivatorUnit\(options, contract\)/,
      );
      assert.match(
        implementation,
        /await startHeadlessVncActivatorUnit\(options, contract\)/,
      );
      assert.match(
        implementation,
        /displayLifecycle:[\s\S]*headlessVncActivatorUnit/,
      );
      assert.match(implementation, /ensureLowerControllerSimCached/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes admission command through without runner proxy/token arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      const withoutProxy = buildReconstructionPlan(options(root), value).at(-1);
      assert.equal(
        withoutProxy.args.includes("--runner-proxy-configured"),
        false,
      );
      assert.equal(
        withoutProxy.args.includes("--runner-registration-token"),
        false,
      );
      assert.equal(withoutProxy.args.includes("--runner-removal-token"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tracked defaults that could encode a host address", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      assert.throws(() => options(root, "invalid"), /--mode/);
      assert.throws(() => {
        parseOptions([
          "reconstruct",
          "--mode",
          "fast",
          "--run-id",
          "x",
          "--workspace",
          root,
          "--state-root",
          join(root, "state"),
          "--baseline-contract",
          join(root, "contract"),
          "--host-private-address",
          "127.0.0.1",
          "--out",
          join(root, "out"),
        ]);
      }, /non-loopback IPv4/);
      assert.equal(
        parseOptions([
          "reconstruct",
          "--mode",
          "fast",
          "--run-id",
          "x",
          "--workspace",
          root,
          "--state-root",
          join(root, "state"),
          "--baseline-contract",
          join(root, "contract"),
          "--host-private-address",
          "10.0.0.16",
          "--out",
          join(root, "out"),
        ]).hostPrivateAddress,
        "10.0.0.16",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("supported API seeding", () => {
  it("uses only real Admin API endpoints with controller-compatible bodies", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/local-testbed-catalog.json", import.meta.url),
        "utf8",
      ),
    );
    fixture.slots[0].capacity = 2;
    fixture.slots[0].onHandQty = 10;
    const calls = [];
    const uploads = [];
    const request = async (_base, path, input = {}) => {
      calls.push({ path, ...input });
      if (path === "/auth/login") return { accessToken: "admin-token" };
      if (path === "/products") return { id: `product-${calls.length}` };
      if (path === "/product-variants")
        return { id: `variant-${calls.length}`, sku: input.body.sku };
      if (path === "/payments/providers")
        return [{ id: "mock-provider", code: "mock", status: "enabled" }];
      if (path === "/machines")
        return { id: "machine-1", code: "VEM-TESTBED-LOCAL" };
      if (path === "/machines/machine-1")
        return { id: "machine-1", code: "VEM-TESTBED-LOCAL", status: "online" };
      if (path.endsWith("/slots")) return { id: `slot-${calls.length}` };
      if (path === "/inventories") return { id: `inventory-${calls.length}` };
      if (path === "/try-on-garments")
        return {
          id: `garment-${calls.filter((call) => call.path === path).length}`,
        };
      if (path.includes("/try-on-garments/")) return { id: path.split("/")[2] };
      if (path.endsWith("/planogram-versions"))
        return { planogramVersion: "LOCAL-TESTBED-V1" };
      if (path.endsWith("/claim-codes"))
        return { id: "claim-1", claimCode: "ABCD-1234" };
      if (path.includes("/payments/providers/"))
        return { id: "mock-provider", status: "enabled" };
      throw new Error(`unexpected path: ${path}`);
    };
    const upload = async (_base, path, input = {}) => {
      const productDisplayIds = [
        "550e8400-e29b-41d4-a716-446655440124",
        "550e8400-e29b-41d4-a716-446655440126",
        "550e8400-e29b-41d4-a716-446655440127",
      ];
      const garmentAssetIds = [
        "550e8400-e29b-41d4-a716-446655440125",
        "550e8400-e29b-41d4-a716-446655440128",
      ];
      const id =
        path === "/media-assets/try-on-garments"
          ? garmentAssetIds[
              uploads.filter((upload) => upload.path === path).length
            ]
          : productDisplayIds[
              uploads.filter(
                (upload) =>
                  upload.path === "/media-assets/product-display-images",
              ).length
            ];
      const asset = {
        id,
        publicUrl: `/api/media-assets/${id}/content`,
        contentType: "image/png",
      };
      uploads.push({ path, ...input, asset });
      return asset;
    };
    const result = await seedThroughSupportedApis({
      baseUrl: "http://127.0.0.1:26849/api",
      fixture,
      hostPrivateAddress: "10.0.0.15",
      request,
      upload,
    });
    assert.equal(result.machine.code, "VEM-TESTBED-LOCAL");
    assert.deepEqual(
      calls.find((call) => call.path === "/machines/machine-1"),
      {
        path: "/machines/machine-1",
        method: "PATCH",
        token: "admin-token",
        body: { status: "online" },
      },
    );
    assert.equal(uploads.length, 5);
    assert.deepEqual(uploads[0], {
      path: "/media-assets/try-on-garments",
      token: "admin-token",
      fileName: "local-testbed-try-on-garment.png",
      contentType: "image/png",
      buffer: uploads[0].buffer,
      asset: uploads[0].asset,
    });
    assert.ok(Buffer.isBuffer(uploads[0].buffer));
    assert.deepEqual(pngDimensions(uploads[0].buffer), {
      width: 512,
      height: 640,
    });
    assert.ok(createHash("sha256").update(uploads[0].buffer).digest("hex"));
    assert.equal(uploads[1].path, "/media-assets/try-on-garments");
    assert.equal(uploads[1].fileName, "local-testbed-try-on-garment-long.png");
    assert.notEqual(
      createHash("sha256").update(uploads[0].buffer).digest("hex"),
      createHash("sha256").update(uploads[1].buffer).digest("hex"),
    );
    const productDisplayUploads = uploads.filter(
      (upload) => upload.path === "/media-assets/product-display-images",
    );
    assert.equal(productDisplayUploads.length, 3);
    assert.equal(
      new Set(productDisplayUploads.map((upload) => upload.asset.id)).size,
      3,
    );
    for (const upload of productDisplayUploads) {
      assert.equal(upload.contentType, "image/png");
      assert.ok(Buffer.isBuffer(upload.buffer));
      assert.deepEqual(pngDimensions(upload.buffer), {
        width: 240,
        height: 240,
      });
    }
    const productDisplayAssetIds = new Set(
      productDisplayUploads.map((upload) => upload.asset.id),
    );
    const productCreateCalls = calls.filter(
      (call) => call.path === "/products",
    );
    assert.equal(productCreateCalls.length, 44);
    for (const call of productCreateCalls) {
      assert.ok(productDisplayAssetIds.has(call.body.displayImageMediaAssetId));
    }
    assert.equal(
      new Set(
        productCreateCalls.map((call) => call.body.displayImageMediaAssetId),
      ).size,
      3,
    );
    assert.deepEqual(
      calls.find((call) => call.path === "/payments/providers/mock-provider"),
      {
        path: "/payments/providers/mock-provider",
        method: "PATCH",
        token: "admin-token",
        body: {
          status: "enabled",
        },
      },
    );
    assert.equal(
      calls.some((call) => call.path === "/payments/channel-policy"),
      false,
    );
    assert.deepEqual(
      calls.find((call) => call.path.endsWith("/claim-codes")).body,
      { purpose: "first_claim" },
    );
    assert.ok(
      calls.some(
        (call) => call.path === "/inventories" && call.body.onHandQty === 3,
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.path === "/inventories" &&
          call.body.slotId != null &&
          call.body.onHandQty === 2,
      ),
    );
    assert.ok(
      calls
        .find((call) => call.path.endsWith("/planogram-versions"))
        .body.slots.some((slot) => slot.capacity === 2 && slot.slotId != null),
    );
    assert.deepEqual(
      calls.filter((call) => call.path.startsWith("/try-on-garments/")),
      [
        {
          path: "/try-on-garments/garment-1/confirmation",
          method: "POST",
          token: "admin-token",
          body: {},
        },
        {
          path: "/try-on-garments/garment-1/activation",
          method: "POST",
          token: "admin-token",
          body: {},
        },
        {
          path: "/try-on-garments/garment-2/confirmation",
          method: "POST",
          token: "admin-token",
          body: {},
        },
        {
          path: "/try-on-garments/garment-2/activation",
          method: "POST",
          token: "admin-token",
          body: {},
        },
        calls.find(
          (call) =>
            call.path === "/try-on-garments/garment-1/variant-associations",
        ),
        calls.find(
          (call) =>
            call.path === "/try-on-garments/garment-2/variant-associations",
        ),
      ],
    );
    assert.equal(result.visionAcceptance.tryOnGarmentId, "garment-1");
    assert.equal(
      result.visionAcceptance.tryOnGarmentMediaAssetId,
      "550e8400-e29b-41d4-a716-446655440125",
    );
    assert.deepEqual(result.visionAcceptance.aiTryOnCases, [
      {
        caseKey: "short",
        template: "tshirt_short_sleeve",
        garmentId: "garment-1",
        garmentMediaAssetId: "550e8400-e29b-41d4-a716-446655440125",
        garmentSha256: createHash("sha256")
          .update(uploads[0].buffer)
          .digest("hex"),
        selectedCatalogKey: result.visionAcceptance.selectedCatalogKey,
        selectedVariantId:
          result.visionAcceptance.recommendationVariants[0].variantId,
        size: "S",
      },
      {
        caseKey: "long",
        template: "tshirt_long_sleeve",
        garmentId: "garment-2",
        garmentMediaAssetId: "550e8400-e29b-41d4-a716-446655440128",
        garmentSha256: createHash("sha256")
          .update(uploads[1].buffer)
          .digest("hex"),
        selectedCatalogKey: result.visionAcceptance.selectedCatalogKey,
        selectedVariantId:
          result.visionAcceptance.recommendationVariants[1].variantId,
        size: "M",
      },
    ]);
    assert.equal(result.visionAcceptance.tryOnCategoryKey, "tshirts");
    assert.deepEqual(
      result.visionAcceptance.productMedia.map((entry) => ({
        categoryKey: entry.categoryKey,
        catalogKey: entry.catalogKey,
        coverImageUrl: entry.coverImageUrl,
      })),
      ["socks", "underwear", "tshirts"].map((categoryKey, index) => ({
        categoryKey,
        catalogKey: `product:${result.visionAcceptance.productMedia[index].productId}`,
        coverImageUrl: productDisplayUploads[index].asset.publicUrl,
      })),
    );
    assert.deepEqual(
      result.visionAcceptance.seededTryOnVariants.map((entry) => ({
        garmentId: entry.garmentId,
        garmentMediaAssetId: entry.garmentMediaAssetId,
        variantId: entry.variantId,
      })),
      [
        {
          garmentId: "garment-1",
          garmentMediaAssetId: "550e8400-e29b-41d4-a716-446655440125",
          variantId:
            result.visionAcceptance.recommendationVariants[0].variantId,
        },
        {
          garmentId: "garment-2",
          garmentMediaAssetId: "550e8400-e29b-41d4-a716-446655440128",
          variantId:
            result.visionAcceptance.recommendationVariants[1].variantId,
        },
      ],
    );
    assert.deepEqual(
      result.visionAcceptance.recommendationVariants.map((entry) => ({
        productId: entry.productId,
        variantId: entry.variantId,
        size: entry.size,
        slotId: entry.slotId,
        inventoryId: entry.inventoryId,
        onHandQty: entry.onHandQty,
      })),
      [
        {
          productId:
            result.visionAcceptance.recommendationVariants[0].productId,
          variantId:
            result.visionAcceptance.recommendationVariants[0].variantId,
          size: "S",
          slotId: result.visionAcceptance.recommendationVariants[0].slotId,
          inventoryId:
            result.visionAcceptance.recommendationVariants[0].inventoryId,
          onHandQty: 3,
        },
        {
          productId:
            result.visionAcceptance.recommendationVariants[0].productId,
          variantId:
            result.visionAcceptance.recommendationVariants[1].variantId,
          size: "M",
          slotId: result.visionAcceptance.recommendationVariants[1].slotId,
          inventoryId:
            result.visionAcceptance.recommendationVariants[1].inventoryId,
          onHandQty: 3,
        },
      ],
    );
    assert.equal(
      new Set(
        result.visionAcceptance.recommendationVariants.map(
          (entry) => entry.productId,
        ),
      ).size,
      1,
    );
    const seededTryOnVariantIds = new Set(
      result.visionAcceptance.aiTryOnCases.map(
        (entry) => entry.selectedVariantId,
      ),
    );
    const tryOnInventoryCalls = calls.filter(
      (call) =>
        call.path === "/inventories" &&
        seededTryOnVariantIds.has(call.body.variantId),
    );
    assert.ok(
      tryOnInventoryCalls.some((call) => call.body.onHandQty > 0),
      "at least one try-on T-shirt variant must have positive inventory",
    );
    const planogramCall = calls.find((call) =>
      call.path.endsWith("/planogram-versions"),
    );
    assert.ok(
      planogramCall.body.slots.every((slot) =>
        productDisplayUploads.some(
          (upload) => slot.coverImageUrl === upload.asset.publicUrl,
        ),
      ),
      "every published slot must retain its product main-image managed reference",
    );
    assert.equal(
      new Set(planogramCall.body.slots.map((slot) => slot.coverImageUrl)).size,
      3,
    );
    assert.ok(
      planogramCall.body.slots.some(
        (slot) =>
          seededTryOnVariantIds.has(slot.variantId) &&
          tryOnInventoryCalls.some(
            (inventory) => inventory.body.variantId === slot.variantId,
          ),
      ),
      "a stocked try-on T-shirt variant must be present in the published planogram",
    );
    assert.doesNotMatch(JSON.stringify(calls), /channel-policy/);
  });
});

describe("Windows D cache contract", () => {
  it("cleans only the uniquely managed canonical Vision and acceptance-owned Node mock before both full and fast runs", () => {
    const guestScript = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(
      guestScript,
      /function Clear-TestbedVisionProcesses\(\[object\]\$GuestInput\)/,
    );
    assert.match(
      guestScript,
      /\$visionMockControlPort = \[int\]\$GuestInput\.hostControlPlane\.visionMockControlPort/,
    );
    assert.match(
      guestScript,
      /canonicalVisionAppDirectory = "C:\\VEM\\vision\\app"[\s\S]*canonicalVisionConfigPath = "C:\\ProgramData\\VEM\\vision\\site\.json"/,
    );
    assert.match(
      guestScript,
      /function Get-TestbedCanonicalVisionProcesses[\s\S]*Get-CimInstance Win32_Process[\s\S]*ExecutablePath[\s\S]*canonicalVisionExecutablePath[\s\S]*Test-VisionMainCanonicalConfigurationCommandLine[\s\S]*canonicalVisionConfigurationPath/,
    );
    assert.match(
      guestScript,
      /unknownCanonicalVisionProcesses[\s\S]*throw "Vision bootstrap found unknown canonical executable processes/,
    );
    assert.match(
      guestScript,
      /function Stop-TestbedCanonicalVision[\s\S]*Import-Module[\s\S]*-PassThru[\s\S]*Stop-VisionMainTask -AppDirectory \$CanonicalAppDirectory -ConfigurationPath \$CanonicalConfigurationPath[\s\S]*managedCanonicalVisionProcesses\.Count -gt 0[\s\S]*Stop-TestbedCanonicalVision \$canonicalVisionAppDirectory \$canonicalVisionConfigPath[\s\S]*remainingCanonicalVisionProcesses[\s\S]*canonical Vision process cleanup did not complete/,
    );
    assert.match(
      guestScript,
      /visionMockOwnerIds[\s\S]*LocalPort -eq \$visionMockControlPort[\s\S]*ExecutablePath -match[\s\S]*vision-mock[\s\S]*Stop-Process -Id \$ownerId/,
    );
    assert.doesNotMatch(guestScript, /Get-Process vending-vision/);
    assert.doesNotMatch(
      guestScript,
      /Stop-ScheduledTask -TaskName "StartVisionServer"/,
    );
    assert.match(
      guestScript,
      /unknownVisionListeners[\s\S]*throw "Vision bootstrap found unknown listener owners/,
    );
    assert.match(guestScript, /Vision bootstrap cleanup did not release ports/);
    const windowsHarness = readFileSync(
      new URL(
        "../windows/vision-main-consumer.windows-harness.ps1",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(windowsHarness, /canonical listener was not stopped/);
    assert.match(windowsHarness, /canonical non-listener was not stopped/);
    assert.match(
      windowsHarness,
      /wrong-config canonical process did not fail closed/,
    );
    assert.match(windowsHarness, /canonical exit race was not tolerated/);
    assert.match(windowsHarness, /mock listener was not stopped/);
    assert.match(windowsHarness, /unknown listener owner did not fail closed/);
    assert.match(
      guestScript,
      /if \(\$Mode -in @\("fast", "full"\)\) \{\s+Clear-TestbedVisionProcesses \$guestInput\s+\}/,
    );
    assert.ok(
      guestScript.indexOf("Clear-TestbedVisionProcesses $guestInput") <
        guestScript.indexOf("$isWarmFastRun ="),
    );
    assert.equal(
      (
        guestScript.match(
          /Stop-ScheduledTask -TaskName "StartVisionServer"/g,
        ) ?? []
      ).length,
      0,
    );
  });

  it("starts a fresh simulated serial session for warm and reconstructed runs", () => {
    const guestScript = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(
      guestScript,
      /Write-TestbedPhase "start-simulated-hardware"\s+\$commissioningSerialSession = Start-TestbedCommissioningSerialSession \$guestInput\s+Write-TestbedSerialDiscoveryAdapter/,
    );
    assert.doesNotMatch(
      guestScript,
      /if \(\$Mode -eq "full"\) \{\s+Write-TestbedPhase "start-simulated-hardware"/,
    );
    assert.doesNotMatch(
      guestScript,
      /warm fast run requires the existing commissioning serial session/,
    );
    const mainSerialStart = guestScript.indexOf(
      "$commissioningSerialSession = Start-TestbedCommissioningSerialSession $guestInput",
    );
    const mainOwnerStart = guestScript.indexOf(
      "$startupState = Start-TestbedInstalledRuntimeOwners",
      mainSerialStart,
    );
    assert.ok(
      mainSerialStart >= 0 && mainOwnerStart > mainSerialStart,
      "the main runtime path must open simulated serial before installed owners",
    );
    assert.match(
      guestScript,
      /while \(\[DateTime\]::UtcNow -lt \$deadline\)\s+if \(\$null -eq \$binding -or -not \$binding\.ready\) \{\s+try \{\s+\$snapshot = Invoke-RestMethod/,
    );
  });

  it("adapts stable QEMU USB ports to production device identities without fixed COM numbers", () => {
    const guestScript = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(guestScript, /function Write-TestbedSerialDiscoveryAdapter/);
    assert.match(guestScript, /DEVPKEY_Device_Parent/);
    assert.match(guestScript, /VID_1A86&PID_7523/);
    assert.match(guestScript, /VID_1A86&PID_55D3/);
    assert.match(guestScript, /VEM_TESTBED_SERIAL_DISCOVERY_FILE/);
    assert.match(guestScript, /while \(\[DateTime\]::UtcNow -lt \$deadline\)/);
    assert.doesNotMatch(
      guestScript.match(
        /function Write-TestbedSerialDiscoveryAdapter[\s\S]*?\n}/,
      )?.[0] ?? "",
      /COM(?:3|4|10)/,
    );
  });

  it("changes the host simulator cache key when its local runtime sources change", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-local-testbed-simulator-key-"),
    );
    try {
      for (const [path, contents] of [
        ["Cargo.lock", "lock-v1\n"],
        ["Cargo.toml", "[workspace]\n"],
        ["apps/lower-controller-sim/Cargo.toml", "[package]\n"],
        ["apps/lower-controller-sim/src/main.rs", "fn main() {}\n"],
        ["crates/vending-core/Cargo.toml", "[package]\n"],
        ["crates/vending-core/src/lib.rs", "pub fn core() {}\n"],
      ]) {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, contents);
      }
      const original = await lowerControllerSimSourceFingerprint(root);
      writeFileSync(
        join(root, "crates/vending-core/src/lib.rs"),
        "pub fn core() { changed(); }\n",
      );
      const changed = await lowerControllerSimSourceFingerprint(root);

      assert.match(original, /^[a-f0-9]{64}$/);
      assert.notEqual(changed, original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses a source-keyed host simulator binary from the persistent state root", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-local-testbed-simulator-cache-"),
    );
    try {
      const parsedOptions = options(root);
      const sourceDigest = "a".repeat(64);
      const layout = lowerControllerSimCacheLayout(parsedOptions, sourceDigest);
      let binaryPresent = false;
      let markerPresent = false;
      const commands = [];
      const dependencies = {
        ensureDirectory: async () => {},
        isExecutable: async () => binaryPresent,
        markerPresent: async () => markerPresent,
        publishMarker: async () => {
          markerPresent = true;
        },
        runCommand: async (command, args, commandOptions) => {
          commands.push({ command, args, commandOptions });
          binaryPresent = true;
        },
      };
      const first = await ensureLowerControllerSimCached({
        options: parsedOptions,
        sourceDigest,
        dependencies,
      });
      const second = await ensureLowerControllerSimCached({
        options: parsedOptions,
        sourceDigest,
        dependencies,
      });

      assert.equal(first.cache, "miss");
      assert.equal(second.cache, "hit");
      assert.equal(first.binaryPath, layout.binaryPath);
      assert.equal(first.successMarkerPath, layout.successMarkerPath);
      assert.equal(commands.length, 1);
      assert.deepEqual(commands[0].args, [
        "build",
        "-p",
        "lower-controller-sim",
        "--locked",
      ]);
      assert.equal(
        commands[0].commandOptions.env.CARGO_TARGET_DIR,
        layout.targetDirectory,
      );
      assert.match(layout.binaryPath, /state\/host-lower-controller-sim\//);
      assert.doesNotMatch(layout.binaryPath, /192\.168\.2\.22/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes old host simulator cache digests while preserving current and non-cache entries", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-local-testbed-simulator-cache-prune-"),
    );
    try {
      const parsedOptions = options(root);
      const sourceDigest = "a".repeat(64);
      const staleDigest = "b".repeat(64);
      const laterStaleDigest = "c".repeat(64);
      const layout = lowerControllerSimCacheLayout(parsedOptions, sourceDigest);
      const cacheRoot = dirname(layout.root);
      mkdirSync(cacheRoot, { recursive: true });
      mkdirSync(join(cacheRoot, staleDigest), { recursive: true });
      mkdirSync(join(cacheRoot, sourceDigest), { recursive: true });
      writeFileSync(join(cacheRoot, "not-a-cache"), "keep");
      writeFileSync(join(cacheRoot, "123"), "keep");

      let binaryPresent = false;
      let markerPresent = false;
      const commands = [];
      const dependencies = {
        ensureDirectory: async () => {},
        isExecutable: async () => binaryPresent,
        markerPresent: async () => markerPresent,
        publishMarker: async () => {
          markerPresent = true;
        },
        runCommand: async (command, args, commandOptions) => {
          commands.push({ command, args, commandOptions });
          binaryPresent = true;
        },
      };
      await ensureLowerControllerSimCached({
        options: parsedOptions,
        sourceDigest,
        dependencies,
      });
      assert.equal(existsSync(join(cacheRoot, staleDigest)), false);
      assert.equal(existsSync(join(cacheRoot, sourceDigest)), true);
      assert.equal(existsSync(join(cacheRoot, "not-a-cache")), true);
      assert.equal(existsSync(join(cacheRoot, "123")), true);

      mkdirSync(join(cacheRoot, laterStaleDigest), { recursive: true });
      await ensureLowerControllerSimCached({
        options: parsedOptions,
        sourceDigest,
        dependencies,
      });
      assert.equal(commands.length, 1);
      assert.equal(existsSync(join(cacheRoot, laterStaleDigest)), false);
      assert.equal(existsSync(join(cacheRoot, sourceDigest)), true);
      assert.equal(existsSync(join(cacheRoot, "not-a-cache")), true);
      assert.equal(existsSync(join(cacheRoot, "123")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when outdated cache cleanup cannot be removed", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-local-testbed-simulator-cache-fail-closed-"),
    );
    try {
      const parsedOptions = options(root);
      const sourceDigest = "a".repeat(64);
      const staleDigest = "b".repeat(64);
      const layout = lowerControllerSimCacheLayout(parsedOptions, sourceDigest);
      const cacheRoot = dirname(layout.root);
      const removed = [];
      mkdirSync(cacheRoot, { recursive: true });
      mkdirSync(join(cacheRoot, staleDigest), { recursive: true });
      let binaryPresent = false;
      let markerPresent = false;
      await assert.rejects(
        () =>
          ensureLowerControllerSimCached({
            options: parsedOptions,
            sourceDigest,
            dependencies: {
              ensureDirectory: async () => {},
              isExecutable: async () => binaryPresent,
              markerPresent: async () => markerPresent,
              publishMarker: async () => {
                markerPresent = true;
              },
              runCommand: async () => {
                binaryPresent = true;
              },
              listDirectory: async () => [
                { name: staleDigest, isDirectory: () => true },
                { name: sourceDigest, isDirectory: () => true },
              ],
              removeDirectory: async (path) => {
                removed.push(path);
                throw new Error("remove-failed");
              },
            },
          }),
        /remove-failed/,
      );
      assert.deepEqual(removed, [join(cacheRoot, staleDigest)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses tool-supported cache settings and clear_cache removes only declared directories", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    const serialStart = guest.indexOf(
      "$commissioningSerialSession = Start-TestbedCommissioningSerialSession",
    );
    const hardwareBinding = guest.indexOf(
      "$startupState = Start-TestbedInstalledRuntimeOwners",
      serialStart,
    );
    assert.ok(serialStart >= 0 && hardwareBinding > serialStart);
    const bindingFunction = guest.match(
      /function Initialize-TestbedHardwareBindings \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(bindingFunction);
    assert.match(
      bindingFunction,
      /production auto-binding did not become ready/,
    );
    assert.doesNotMatch(bindingFunction, /\/test|\/confirm|Method Post/);
    assert.match(
      bindingFunction,
      /try \{[\s\S]*Invoke-RestMethod[\s\S]*\} catch \{[\s\S]*lastBindingError/,
    );
    assert.match(
      guest,
      /commissioningSerialSession = \$commissioningSerialSession/,
    );
    assert.match(
      guest,
      /Stop-TestbedScannerBindingProbe \$guestInput \$commissioningSerialSession/,
    );
    const ownerFunction = guest.match(
      /function Start-TestbedInstalledRuntimeOwners \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(ownerFunction);
    assert.match(
      ownerFunction,
      /if \(\$ClaimBeforeInteractiveOwners\) \{[\s\S]*\$ownerClaim = Invoke-Claim \$GuestInput[\s\S]*restart-claimed-installed-runtime-owner[\s\S]*Restart-TestbedDaemonServiceOwner \$DaemonPath[\s\S]*\$runtimeReady = Wait-RuntimeReady[\s\S]*\}[\s\S]*Write-TestbedPhase "bind-installed-owner-hardware"[\s\S]*Initialize-TestbedHardwareBindings[\s\S]*\$runtimeReady = Wait-RuntimeReady/,
    );
    assert.match(
      ownerFunction,
      /if \(-not \[bool\]\$ownerClaim\.restartRequested\)/,
    );
    assert.doesNotMatch(guest, /\$daemonProcess \| Stop-Process -Force/);
    const claimedRestart = guest.indexOf(
      'Write-TestbedPhase "restart-claimed-installed-runtime-owner"',
    );
    const finalReadyRefresh = guest.lastIndexOf(
      "$runtimeReady = Wait-RuntimeReady",
    );
    const handoffWrite = guest.indexOf(
      'schemaVersion = "vem-installed-runtime-handoff/v1"',
    );
    assert.ok(finalReadyRefresh > claimedRestart);
    assert.ok(finalReadyRefresh < handoffWrite);
    assert.match(
      guest,
      /GetEnvironmentVariable\("Path", "Machine"\)[\s\S]*Join-String -Separator ";"/,
    );
    assert.match(
      guest,
      /Join-Path \$PSScriptRoot "\.\.\\\.\."[\s\S]*Set-Location -LiteralPath \$repoRoot/,
    );
    for (const required of [
      "$env:CARGO_HOME",
      "$env:CARGO_BUILD_JOBS",
      "$env:RUSTC_WRAPPER",
      "sccache --show-stats",
      "& $pnpm config set store-dir",
      "& $pnpm config get store-dir",
      "& $pnpm config set virtual-store-dir",
      "& $pnpm config get virtual-store-dir",
      "Invoke-TestbedQuietCommand",
      "& $pnpm --reporter=silent fetch --frozen-lockfile --trust-lockfile",
      "& $pnpm --reporter=silent install --frozen-lockfile --offline --trust-lockfile",
      "--output-logs=errors-only --log-order=grouped --log-prefix=task",
      "--cache-dir $env:TURBO_CACHE_DIR",
      "$env:CARGO_TARGET_DIR",
      "$env:SCCACHE_DIR",
      '[Environment]::GetEnvironmentVariable("Path", "Machine")',
    ])
      assert.match(
        guest,
        new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    assert.match(guest, /function Clear-DeclaredCaches/);
    assert.doesNotMatch(guest, /sccache --zero-stats|Compile requests/);
    assert.doesNotMatch(guest, /cargo metadata --format-version 1/);
    assert.match(
      guest,
      /Test-Path -LiteralPath \$cargoRegistrySource -PathType Container/,
    );
    assert.match(
      guest,
      /Get-ChildItem[\s\S]*webview2-com-sys-[^\r\n]+[\s\S]*x64\\WebView2Loader\.dll/,
    );
    assert.match(guest, /C:\\Program Files\\nodejs\\pnpm\.cmd/);
    assert.match(
      guest,
      /proxyBypass = @\("localhost", "127\.0\.0\.1", "::1"\)/,
    );
    assert.match(guest, /\$env:no_proxy = \$env:NO_PROXY/);
    assert.match(
      guest,
      /--filter machine exec tauri build --config src-tauri\/tauri\.windows\.conf\.json --no-bundle/,
    );
    assert.match(guest, /function Get-TestbedSccache/);
    assert.match(guest, /sccache-v\$version-x86_64-pc-windows-msvc\.zip/);
    assert.match(guest, /Join-Path \$cacheRoot "sccache\\bin\\\$version"/);
    assert.match(guest, /Join-Path \$cacheRoot "cargo-home"/);
    assert.match(guest, /Join-Path \$cacheRoot "pnpm-store"/);
    assert.match(guest, /Join-Path \$cacheRoot "pnpm-virtual-store"/);
    assert.match(
      guest,
      /Get-FileHash -LiteralPath \$pnpmLockPath -Algorithm SHA256/,
    );
    assert.match(
      guest,
      /\$pnpmFetchCompletePath = Join-Path \$pnpmVirtualStorePath "\.fetch-complete"/,
    );
    assert.match(
      guest,
      /if \(-not \(Test-Path -LiteralPath \$pnpmFetchCompletePath -PathType Leaf\)\) \{[\s\S]*Invoke-TestbedQuietCommand "pnpm fetch" \(Join-Path \$cacheRoot "logs\\pnpm-fetch-\$pnpmLockDigest\.log"\)[\s\S]*Set-Content -LiteralPath \$pnpmFetchCompletePath/,
    );
    assert.match(
      guest,
      /Invoke-TestbedQuietCommand "pnpm install" \(Join-Path \$cacheRoot "logs\\pnpm-install-\$pnpmLockDigest\.log"\)/,
    );
    assert.match(
      guest,
      /function Clear-DeclaredCaches \{\s+foreach \(\$path in \$declaredCachePaths\) \{\s+Remove-Item -LiteralPath \$path -Recurse -Force -ErrorAction SilentlyContinue/s,
    );
    assert.match(
      guest,
      /\$retainedToolPaths = @\([\s\S]*Join-Path \$cacheRoot "powershell"[\s\S]*\$allowedRetainedPaths = @\(\$declaredCachePaths\) \+ @\(\$retainedToolPaths\)/,
    );
    assert.match(
      guest,
      /function Remove-UndeclaredCacheDirectories \{[\s\S]*foreach \(\$path in \$allowedRetainedPaths\)/,
    );
    const clearFunction = guest.match(
      /function Clear-DeclaredCaches \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(clearFunction);
    assert.equal(
      (clearFunction.match(/Remove-Item -LiteralPath/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(guest, /Remove-Item -LiteralPath \$cacheRoot -Recurse/);
    assert.doesNotMatch(guest, /CARGO_REGISTRY_CACHE|CARGO_GIT_CACHE/);
  });

  it("leaves the default Vision owner AI-free until the selected track starts a fresh phase", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    const started = guest.indexOf(
      "$startupState = Start-TestbedInstalledRuntimeOwners",
    );
    assert.ok(started >= 0);
    assert.match(
      guest,
      /Start-TestbedInstalledRuntimeOwners[\s\S]*-VisionAiModelPackRoot \$null[\s\S]*-VisionAiAcceptanceEvidenceRoot \$null/,
    );
    assert.doesNotMatch(
      guest,
      /New-TestbedAiVisionOwnerConfiguration \$guestInput "short"/,
    );
  });

  it("restarts the one Vision owner without overlapping short and long sinks", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        "scripts/testbed/run-local-testbed-guest-ai-owner.windows-harness.ps1",
      ],
      { cwd: new URL("../..", import.meta.url), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, "vem-ai-owner-restart-harness/v1");
    assert.notEqual(output.shortRoot, output.longRoot);
    for (const failurePoint of ["install", "start", "ready"]) {
      assert.equal(
        output.failures[failurePoint].includes("install-default"),
        true,
      );
      assert.deepEqual(output.failures[failurePoint].slice(-2), [
        "start-task:VEMVisionRuntime",
        "ready",
      ]);
    }
  });

  it("does not require reconstructed guest input for clear_cache", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.ok(
      guest.indexOf('if ($Mode -eq "clear_cache")') <
        guest.indexOf("Require-Path $GuestInputPath"),
    );
  });

  it("keeps fast runs on the build/deploy path without replacing claimed state", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    const fast = guest.indexOf("$isWarmFastRun =");
    const dependencies = guest.indexOf('Write-TestbedPhase "dependencies"');
    const machineBuild = guest.indexOf('Write-TestbedPhase "machine-build"');
    const deploy = guest.indexOf('Write-TestbedPhase "deploy-runtime"');
    const acceptance = guest.indexOf('Write-TestbedPhase "acceptance-tracks"');
    assert.ok(fast >= 0 && fast < dependencies && dependencies < machineBuild);
    assert.doesNotMatch(guest.slice(fast, dependencies), /exit 0/);
    assert.ok(machineBuild < deploy && deploy < acceptance);
    assert.match(
      guest,
      /reuse-pass-1-runtime-artifacts[\s\S]*reuse-commit-runtime-artifacts/,
    );
    assert.match(
      guest,
      /function Stop-TestbedInstalledRuntimeBeforeDeployment[\s\S]*AddSeconds\(30\)[\s\S]*installed runtime processes did not stop before deployment: \$summary/,
    );
    assert.match(
      guest,
      /runtimeArtifactSourceDigest = Get-RuntimeArtifactSourceDigest[\s\S]*runtime artifact manifest does not match the requested runtime source digest[\s\S]*runtime artifact digest mismatch/,
    );
    assert.match(
      guest,
      /foreach \(\$artifactName in @\("daemon", "machine", "webViewLoader"\)\)[\s\S]*runtime artifact manifest is missing: \$artifactName/,
    );
    assert.match(
      guest,
      /reusedFromCommitCache = \$runtimeArtifactReuseSource -eq "commit_cache"/,
    );
    assert.match(
      guest,
      /function Get-RuntimeArtifactSourceDigest[\s\S]*apps\\machine\\src[\s\S]*packages\\shared\\src[\s\S]*\.Name -notmatch '\\\.\(spec\|test\)\\\.\[\^.\]\+\$'/,
    );
    assert.match(
      guest,
      /function Get-LocalRustSourceDigest[\s\S]*\.vem-local-rust-source\.sha256[\s\S]*if \(\$cachedLocalRustSourceDigest -ne \$localRustSourceDigest\) \{\s+Write-TestbedPhase "clean-local-runtime-artifacts"\s+cargo clean --release -p machine -p vending-daemon -p vending-core -p daemon-ipc-contracts[\s\S]*Set-Content -LiteralPath \$localRustSourceMarker -Value \$localRustSourceDigest/,
    );
    assert.match(
      guest,
      /if \(\$Mode -eq "full" -or -not \$isWarmFastRun\) \{\s+\$guestInput\.runtimeBootstrap[\s\S]*Set-Content -LiteralPath \(Join-Path \$runtimeRoot "runtime-bootstrap\.json"/,
    );
    assert.match(
      guest,
      /\$isWarmFastRun = \$Mode -eq "fast" -and \(Test-Path -LiteralPath \$handoffPath -PathType Leaf\)[\s\S]*\$existingClaimMatchesInput[\s\S]*claim\.claimCode -eq \$guestInput\.claimCode[\s\S]*if \(\$Mode -eq "fast" -and -not \$isWarmFastRun\) \{\s+Write-TestbedPhase "cold-fast-bootstrap"/,
    );
    assert.match(
      guest,
      /claim = \[ordered\]@\{ status = \[string\]\$claim\.status; machineCode = \[string\]\$claim\.machineCode; claimCode = \[string\]\$guestInput\.claimCode \}/,
    );
    assert.match(
      guest,
      /-ClaimBeforeInteractiveOwners:\(\$Mode -eq "full" -or -not \$isWarmFastRun\)/,
    );
    assert.match(
      guest,
      /Start-TestbedCommissioningSerialSession \$guestInput[\s\S]*Stop-TestbedScannerBindingProbe/,
    );
    assert.match(guest, /Start-TestbedInstalledRuntimeOwners `/);
    assert.doesNotMatch(guest, /Remove-Item -LiteralPath \$daemonDataRoot/);
    assert.match(
      guest,
      /Wait-CanonicalProcessEvidence "machine\.exe" \$MachinePath 30/,
    );
    assert.match(guest, /Get-CdpProcessBinding \$machineEvidence\.processId/);
  });

  it("installs the real Vision artifact and runs the independent try-on acceptance only in full mode", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    const orchestrator = readFileSync(
      new URL("./full-workflow-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(guest, /function Write-RecordedVisionSiteConfiguration/);
    assert.equal(
      guest.match(/loop = \$true/g)?.length,
      1,
      "only the front try-on source loops during horizontal acceptance",
    );
    assert.equal(guest.match(/loop = \$false/g)?.length, 1);
    assert.match(guest, /function Invoke-FullVisionTryOnAcceptance/);
    assert.match(guest, /Get-TestbedProvisionedVisionCoreArtifact/);
    assert.doesNotMatch(guest, /Get-VisionMainArtifactCache/);
    assert.match(
      guest,
      /function Write-TestbedGuestInputAtomically[\s\S]*Move-Item -LiteralPath \$temporaryPath -Destination \$Path -Force -ErrorAction Stop[\s\S]*visionCore[\s\S]*Write-TestbedGuestInputAtomically \$GuestInputPath \$guestInput/,
    );
    assert.match(guest, /Install-VisionMainArtifact/);
    assert.match(guest, /full-workflow-orchestrator\.mjs/);
    assert.match(guest, /installed-ipc-recovery\.json/);
    assert.match(guest, /function Initialize-TestbedHardwareBindings/);
    assert.match(guest, /production auto-binding did not become ready/);
    assert.match(guest, /serial-fulfillment-error\.json/);
    assert.match(guest, /delayed-pickup-native-audio\.json/);
    assert.match(guest, /scanner-payment-code\.json/);
    assert.match(guest, /full-workflow-tracks\.json/);
    assert.match(orchestrator, /business-check-registry\.mjs/);
    assert.match(orchestrator, /selectBusinessChecks/);
    assert.match(orchestrator, /runner\.script[\s\S]*runner\.args/);
    assert.match(
      guest,
      /if \(\$Mode -eq "full"\) \{\s+Write-RecordedVisionSiteConfiguration/,
    );
  });

  it("keeps failed diagnostics but never packages them as uploadable evidence", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(guest, /\$workflowFailure = \$null/);
    assert.match(guest, /\$bundleFailure = \$null/);
    const orchestratorStart = guest.indexOf(
      "node scripts/testbed/full-workflow-orchestrator.mjs --mode $Mode --commit $Commit @focusArguments --guest-input $GuestInputPath --handoff $handoffPath --out $workflowSummaryOutPath",
    );
    const bundleSection = guest.indexOf(
      'if ($Mode -ne "clear_cache")',
      orchestratorStart,
    );
    const manifestCheck = guest.indexOf(
      '$manifestPath = Join-Path $handoffRoot "full-workflow-evidence-manifest.json"',
      bundleSection,
    );
    const bundleCall = guest.indexOf(
      "New-BoundedEvidenceBundle",
      manifestCheck,
    );
    const bundleFailure = guest.indexOf(
      '$bundleFailure = "compact evidence bundle failed:',
      manifestCheck,
    );
    assert.ok(orchestratorStart >= 0);
    assert.doesNotMatch(
      guest,
      /Get-Content -Raw -LiteralPath \$workflowSummaryOutPath \| Write-Output/,
    );
    assert.ok(manifestCheck >= 0 && bundleCall > manifestCheck);
    assert.ok(bundleFailure > bundleCall);
    assert.match(guest, /if \(Test-Path -LiteralPath \$manifestPath\)/);
    assert.match(
      guest,
      /full-workflow-evidence-bundle\.mjs[\s\S]*--manifest \$ManifestPath[\s\S]*--summary \$summaryPath[\s\S]*--smoke \$smokePath[\s\S]*--out \$BundleRoot/,
    );
    const bundleFunction = guest.slice(
      guest.indexOf("function New-BoundedEvidenceBundle"),
      guest.indexOf("function Clear-TestbedRunReports"),
    );
    assert.doesNotMatch(bundleFunction, /Copy-Item|Remove-Item|New-Item/);
    assert.doesNotMatch(
      guest,
      /Remove-Item[^\r\n]*full-workflow-evidence-bundle/,
    );
    assert.match(guest, /\$workflowFailure -ne \$null/);
    assert.match(guest, /\$bundleFailure -ne \$null/);
  });
});

describe("local testbed fixture", () => {
  it("is a tracked normalized snapshot and does not read ignored authoring material at runtime", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/local-testbed-catalog.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(fixture.schemaVersion, "vem-local-testbed-catalog/v1");
    assert.equal(fixture.source, "tracked_testbed_fixture");
    assert.equal(fixture.products.length, 44);
    assert.deepEqual(
      fixture.slots.map((slot) => slot.slotDisplayLabel),
      ["A1", "A2", "A3", "A4", "A5", "B5", "B1", "B2"],
    );
    assert.deepEqual(
      fixture.slots.map((slot) => `${slot.rowNo}:${slot.cellNo}`),
      ["1:1", "1:2", "1:3", "1:4", "1:5", "2:5", "2:1", "2:2"],
    );
    assert.ok(
      fixture.slots.every(
        (slot) =>
          Number.isInteger(slot.rowNo) &&
          Number.isInteger(slot.cellNo) &&
          slot.rowNo >= 1 &&
          slot.rowNo <= 9 &&
          slot.cellNo >= 1 &&
          slot.cellNo <= (slot.rowNo <= 6 ? 5 : slot.rowNo <= 8 ? 4 : 3),
      ),
    );
    const implementation = readFileSync(
      new URL("./local-testbed.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(implementation, /docs\//);
    assert.doesNotMatch(implementation, /唐诗村商品列表\.xlsx/);
    assert.match(implementation, /TESTBED_MEDIA_FIXTURES/);
    assert.match(implementation, /seedThroughSupportedApis/);
    assert.match(implementation, /allocateFullWorkflowFixtures/);
    assert.match(implementation, /\/auth\/login/);
    assert.match(implementation, /\/machines\/\$\{machine\.id\}\/claim-codes/);
    assert.match(implementation, /runtimeBaseIdentity/);
  });
});
