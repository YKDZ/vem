import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  baselinePublicationLayout,
  publishVerifiedBaselineRelease,
  runtimeProfileForPublishedRelease,
} from "./kvm-baseline/linux-kvm-baseline.mjs";
import {
  buildHostLocalServiceApiEnvironment,
  buildMigrationEnvironment,
  buildHostControlPlaneUnitPlan,
  buildReconstructionPlan,
  buildServiceApiUnitPlan,
  interpretServiceApiJournalCapture,
  parseOptions,
  paymentMockCreateGatePaths,
  seedThroughSupportedApis,
  validateBaselineContract,
} from "./local-testbed.mjs";

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
      admitRunnerCommand: [
        "/usr/bin/node",
        hostScript,
        "admit",
        ...commonHostArguments,
        "--guest-input",
        "{guestStagingPath}",
      ],
      guest: {
        host: "win10-testbed.local",
        user: "baseline",
        identityFile: join(root, "id_ed25519"),
        knownHostsFile: join(root, "known_hosts"),
        stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        cacheRoot: "D:\\runtime-cache\\v1",
      },
    },
  };
}

function observedNetworkInterfaces() {
  return {
    eth0: [{ address: "10.0.0.15", family: "IPv4", internal: false }],
  };
}

function options(root, mode = "full") {
  return parseOptions(
    [
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
    ],
    { observeNetworkInterfaces: observedNetworkInterfaces },
  );
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
      sshUser: "baseline",
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
      admitRunnerCommand: [
        "/usr/bin/node",
        hostScript,
        "admit",
        ...commonHostArguments,
        "--guest-input",
        "{guestStagingPath}",
      ],
      guest: {
        host: "win10-testbed.local",
        user: "baseline",
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
  it("requires the generic baseline contract to separate reconstruction from runner admission", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      assert.deepEqual(validateBaselineContract(value), value);
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
      delete value.testbed.admitRunnerCommand;
      assert.throws(
        () => validateBaselineContract(value),
        /admitRunnerCommand/,
      );
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
        rendered.some((step) => step.includes("postgres:16")) &&
          rendered.some((step) =>
            step.includes("local-testbed-host.mjs admit"),
          ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces the fixed Service API systemd unit and keeps readiness diagnostics in journald", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = options(root);
      const plan = buildServiceApiUnitPlan(parsedOptions);
      const serviceEnvironment =
        buildHostLocalServiceApiEnvironment(parsedOptions);
      const migrationEnvironment = buildMigrationEnvironment(parsedOptions, {
        baseEnvironment: { PATH: "/usr/bin", HOME: root, USER: "tester" },
      });
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      assert.match(
        rendered[0],
        /systemctl stop vem-local-testbed-service-api\.service/,
      );
      assert.match(
        rendered.at(-1),
        /systemd-run --unit=vem-local-testbed-service-api --collect/,
      );
      assert.match(rendered.at(-1), /StandardOutput=journal/);
      assert.match(rendered.at(-1), /StandardError=journal/);
      assert.ok(
        plan
          .at(-1)
          .args.includes(
            `--property=WorkingDirectory=${join(root, "state", "service-api-runtime")}`,
          ),
      );
      assert.equal(
        plan.at(-1).args.at(-1),
        join(root, "apps/service-api/dist/main.js"),
      );
      assert.notEqual(plan.at(-1).args.at(-1), "apps/service-api/dist/main.js");
      for (const [name, value] of Object.entries(serviceEnvironment)) {
        assert.ok(plan.at(-1).args.includes(`--setenv=${name}=${value}`));
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
      assert.match(implementation, /journalctl/);
      assert.doesNotMatch(
        implementation,
        /service-api\.pid|detached:\s*true|child\.stdout\.pipe|child\.stderr\.pipe/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes one shared mock create gate path for service-api and fast-sale tracer", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const parsedOptions = options(root);
      const environment = buildHostLocalServiceApiEnvironment(parsedOptions);
      const gate = paymentMockCreateGatePaths(parsedOptions.stateRoot);
      assert.equal(environment.PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH, gate.statePath);
      assert.match(gate.pendingPath, /mock-payment-create-gate\.json\.pending\.json$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when journalctl exits non-zero and only exposes bounded stdout as platform log", () => {
    const bounded = interpretServiceApiJournalCapture({
      ok: true,
      stdout: `stderr-looking-line\n${"x".repeat(20_000)}`,
    });
    assert.deepEqual(bounded.kind, "journal");
    assert.equal(bounded.text.length, 16_000);

    const unavailable = interpretServiceApiJournalCapture({
      ok: false,
      error: "journalctl exited with 1: permission denied",
    });
    assert.deepEqual(unavailable, {
      kind: "unavailable",
      text: "journalctl exited with 1: permission denied",
    });
  });

  it("starts a persistent Linux host control plane and publishes its guest-facing endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      const adapterRelativePath = "scripts/testbed/qemu-usb-serial-host-adapter.mjs";
      mkdirSync(join(root, "scripts/testbed"), { recursive: true });
      writeFileSync(
        join(root, adapterRelativePath),
        readFileSync(new URL(`./qemu-usb-serial-host-adapter.mjs`, import.meta.url)),
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
        new RegExp(`--setenv=VEM_VM_HOST_ADAPTER=${adapterPath.replaceAll("/", "\\/")}`),
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_VERSION=1\.0\.0/,
      );
      assert.match(
        rendered.at(-1),
        new RegExp(`--setenv=VEM_VM_HOST_ADAPTER_SHA256=sha256:${adapterSha256}`),
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_DOMAIN=win10-runtime-testbed/,
      );
      assert.match(
        rendered.at(-1),
        /--setenv=VEM_VM_HOST_ADAPTER_STATE_ROOT=.*host-adapter/,
      );
      assert.doesNotMatch(rendered.at(-1), /fake-vm-host-adapter/);
      const implementation = readFileSync(
        new URL("./local-testbed.mjs", import.meta.url),
        "utf8",
      );
      assert.match(implementation, /hostControlPlane:/);
      assert.match(implementation, /targetIdentity:/);
      assert.match(implementation, /runtimeBaseIdentity:/);
      assert.match(implementation, /26851/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces fixed host state and C overlay before admitting the Windows runner", () => {
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
      const postgresIndex = rendered.findIndex((step) =>
        step.includes("postgres:16"),
      );
      const admissionIndex = rendered.findIndex((step) =>
        step.includes("local-testbed-host.mjs admit"),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes(
            "docker rm -f vem-local-testbed-postgres vem-local-testbed-mosquitto",
          ),
        ),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes(
            "docker volume rm -f vem-local-testbed-postgres-data vem-local-testbed-mosquitto-data",
          ),
        ),
      );
      assert.ok(
        resetIndex >= 0 &&
          resetIndex < postgresIndex &&
          postgresIndex < admissionIndex,
      );
      assert.ok(rendered.some((step) => step.includes("guest-input.json")));
      assert.ok(
        rendered.some((step) =>
          step.includes("cargo build -p lower-controller-sim --locked"),
        ),
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
      assert.match(
        implementation,
        /interactiveUser:\s*contract\.testbed\.guest\.user/,
      );
      assert.match(implementation, /installed-runtime-handoff\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tracked defaults that could encode a host address", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      assert.throws(() => options(root, "invalid"), /--mode/);
      assert.throws(() => {
        parseOptions(
          [
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
          ],
          { observeNetworkInterfaces: observedNetworkInterfaces },
        );
      }, /non-loopback IPv4/);
      assert.throws(() => {
        parseOptions(
          [
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
          ],
          { observeNetworkInterfaces: observedNetworkInterfaces },
        );
      }, /must match a non-loopback IPv4 interface on this host/);
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
      if (path.endsWith("/slots")) return { id: `slot-${calls.length}` };
      if (path === "/inventories") return { id: `inventory-${calls.length}` };
      if (path.endsWith("/planogram-versions"))
        return { planogramVersion: "LOCAL-TESTBED-V1" };
      if (path.endsWith("/claim-codes"))
        return { id: "claim-1", claimCode: "ABCD-1234" };
      if (path.includes("/payments/providers/"))
        return { id: "mock-provider", status: "enabled" };
      throw new Error(`unexpected path: ${path}`);
    };
    const upload = async (_base, path, input = {}) => {
      uploads.push({ path, ...input });
      return {
        id: "550e8400-e29b-41d4-a716-446655440125",
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        contentType: "image/png",
      };
    };
    const result = await seedThroughSupportedApis({
      baseUrl: "http://127.0.0.1:26849/api",
      fixture,
      hostPrivateAddress: "10.0.0.15",
      request,
      upload,
    });
    assert.equal(result.machine.code, "VEM-TESTBED-LOCAL");
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0], {
      path: "/media-assets/try-on-silhouettes",
      token: "admin-token",
      fileName: "local-testbed-try-on-silhouette.png",
      contentType: "image/png",
      buffer: uploads[0].buffer,
    });
    assert.ok(Buffer.isBuffer(uploads[0].buffer));
    assert.equal(calls.filter((call) => call.path === "/products").length, 44);
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
    const tshirtVariantCalls = calls.filter(
      (call) =>
        call.path === "/product-variants" &&
        call.body.tryOnSilhouetteMediaAssetId ===
          "550e8400-e29b-41d4-a716-446655440125",
    );
    assert.equal(tshirtVariantCalls.length, 14);
    assert.deepEqual(result.visionAcceptance, {
      tryOnSilhouetteAssetId: "550e8400-e29b-41d4-a716-446655440125",
      tryOnSilhouettePublicUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
      tryOnCategoryKey: "tshirts",
      seededTryOnVariants: result.visionAcceptance.seededTryOnVariants,
    });
    assert.equal(result.visionAcceptance.seededTryOnVariants.length, 14);
    for (const entry of result.visionAcceptance.seededTryOnVariants) {
      assert.match(entry.variantId, /^variant-\d+$/);
      assert.match(entry.productId, /^product-\d+$/);
      assert.match(entry.sku, /^TSC-LOCAL-\d{3}$/);
      assert.equal(
        entry.silhouetteAssetId,
        "550e8400-e29b-41d4-a716-446655440125",
      );
      assert.equal(
        entry.silhouettePublicUrl,
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
      );
    }
    assert.doesNotMatch(JSON.stringify(calls), /channel-policy/);
  });
});

describe("Windows D cache contract", () => {
  it("uses tool-supported cache settings and clear_cache removes only declared directories", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    for (const required of [
      "$env:CARGO_HOME",
      "$env:RUSTC_WRAPPER",
      "sccache --show-stats",
      "pnpm config set store-dir",
      "pnpm config get store-dir",
      "--cache-dir $env:TURBO_CACHE_DIR",
      "$env:CARGO_TARGET_DIR",
      "$env:SCCACHE_DIR",
    ])
      assert.match(
        guest,
        new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    assert.match(guest, /function Clear-DeclaredCaches/);
    assert.match(guest, /Join-Path \$cacheRoot "cargo-home"/);
    assert.match(guest, /Join-Path \$cacheRoot "pnpm-store"/);
    assert.match(
      guest,
      /function Clear-DeclaredCaches \{\s+foreach \(\$path in \$declaredCachePaths\) \{\s+Remove-Item -LiteralPath \$path -Recurse -Force -ErrorAction SilentlyContinue/s,
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

  it("installs the real Vision artifact and runs the independent try-on acceptance only in full mode", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(guest, /function Write-RecordedVisionSiteConfiguration/);
    assert.match(guest, /function Invoke-FullVisionTryOnAcceptance/);
    assert.match(guest, /Get-VisionMainArtifactCache -CacheRoot \$visionCacheRoot/);
    assert.match(guest, /Install-VisionMainArtifact/);
    assert.match(
      guest,
      /delayed-pickup-native-audio-guest-full\.mjs --mode full/,
    );
    assert.match(guest, /delayed-pickup-native-audio\.json/);
    assert.match(guest, /vision-try-on-acceptance\.mjs --mode full/);
    assert.match(guest, /full-workflow-tracks\.json/);
    assert.match(guest, /\$trackFailures = \[System\.Collections\.Generic\.List\[object\]\]::new\(\)/);
    assert.match(guest, /\$trackSummary = \[ordered\]@\{/);
    assert.match(guest, /track = "fast"/);
    assert.match(guest, /track = "delayedPickup"/);
    assert.match(guest, /track = "vision"/);
    assert.match(guest, /if \(\$trackFailures\.Count -gt 0\) \{/);
    assert.match(
      guest,
      /if \(\$Mode -eq "full"\) \{[\s\S]*Invoke-FullVisionTryOnAcceptance \$GuestInputPath \$HandoffPath \$visionTryOnOutPath[\s\S]*\}/s,
    );
    assert.doesNotMatch(guest, /\b(factory|iso)\b/i);
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
    assert.equal(fixture.products.length, 44);
    assert.deepEqual(
      fixture.slots.map((slot) => slot.slotCode),
      ["A1", "A2"],
    );
    const implementation = readFileSync(
      new URL("./local-testbed.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(implementation, /唐诗村商品列表\.xlsx/);
    assert.match(implementation, /seedThroughSupportedApis/);
    assert.match(implementation, /\/auth\/login/);
    assert.match(implementation, /\/machines\/\$\{machine\.id\}\/claim-codes/);
    assert.match(implementation, /runtimeBaseIdentity/);
  });
});
