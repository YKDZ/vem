import assert from "node:assert/strict";
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
  buildReconstructionPlan,
  buildServiceApiUnitPlan,
  parseOptions,
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
      for (const [name, value] of Object.entries(serviceEnvironment)) {
        assert.ok(plan.at(-1).args.includes(`--setenv=${name}=${value}`));
        assert.equal(migrationEnvironment[name], value);
      }
      assert.equal(
        migrationEnvironment.DOTENV_CONFIG_PATH,
        join(root, "state", "service-api.local-testbed.env"),
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
    const result = await seedThroughSupportedApis({
      baseUrl: "http://127.0.0.1:26849/api",
      fixture,
      hostPrivateAddress: "10.0.0.15",
      request,
    });
    assert.equal(result.machine.code, "VEM-TESTBED-LOCAL");
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
  });
});
