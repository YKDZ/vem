import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWin10Baseline,
  bootstrapScript,
  createConfigurationMedia,
  guestConfigurationFor,
  recoverStaleConstructionDomains,
  renderUnattendedXml,
  SPICE_GUEST_TOOLS_INSTALLER_FILE,
  runWithConstructionSignalCleanup,
  verifyDefinedRuntimeDevices,
  waitForInteractiveDisplayReport,
  waitForGuestVerification,
} from "./build-win10-baseline.mjs";
import {
  createRuntimeProfile,
  renderLibvirtDomainXml,
} from "./libvirt-runtime-profile.mjs";
import {
  BASELINE_PUBLICATION_STAGES,
  baselinePublicationLayout,
  evaluateHostPreflight,
  parseGuestAddress,
  publishVerifiedBaselineRelease,
  readJsonWithBom,
  recoverPublishedBaseline,
  resolvePublishedBaselineRelease,
  runtimeProfileForConfig,
  runtimeProfileForPublishedRelease,
  validateBaselineBuildConfig,
} from "./linux-kvm-baseline.mjs";

function buildConfig(root) {
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
      windowsImageIndex: 1,
      runnerArchivePath: join(root, "media", "actions-runner-win-x64.zip"),
      runnerArchiveSha256: "a".repeat(64),
      spiceGuestToolsInstallerPath: join(
        root,
        "media",
        "spice-guest-tools-0.141.exe",
      ),
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
      registrationTokenProvider: {
        command: join(root, "bin", "issue-runner-token"),
        arguments: ["--repository", "example/runtime"],
      },
      name: "win10-runtime-baseline-runner",
    },
  };
}

function hostIdentity() {
  return {
    hostnames: ["kvm-builder.example.test"],
    addresses: ["192.0.2.10"],
    resolvedConfiguredAddresses: ["192.0.2.10"],
  };
}

function stagedRelease(config, label, contents) {
  const systemStagingDirectory = join(
    dirname(config.storage.baselinePath),
    `.release-test-system-${label}`,
  );
  const cacheStagingDirectory = join(
    dirname(config.storage.cacheDiskPath),
    `.release-test-cache-${label}`,
  );
  mkdirSync(systemStagingDirectory, { recursive: true });
  mkdirSync(cacheStagingDirectory, { recursive: true });
  const paths = {
    system: join(systemStagingDirectory, "system.qcow2"),
    cache: join(cacheStagingDirectory, "cache.qcow2"),
    domainXml: join(systemStagingDirectory, "runtime-profile.xml"),
    diagnostic: join(systemStagingDirectory, "diagnostic.json"),
  };
  writeFileSync(paths.system, `${contents}-system`);
  writeFileSync(paths.cache, `${contents}-cache`);
  writeFileSync(paths.domainXml, `<domain>${contents}</domain>`);
  writeFileSync(paths.diagnostic, JSON.stringify({ contents }));
  return paths;
}

async function publishRelease(config, id, contents, onStage) {
  const staged = stagedRelease(config, id, contents);
  return publishVerifiedBaselineRelease({
    config,
    releaseId: id,
    stagedSystemPath: staged.system,
    stagedCachePath: staged.cache,
    stagedDomainXmlPath: staged.domainXml,
    stagedDiagnosticPath: staged.diagnostic,
    profile: runtimeProfileForPublishedRelease(config, id),
    verified: true,
    commitDefinition: async () => {},
    rollbackDefinition: async () => {},
    onStage,
  });
}

function readFakeLibvirtState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeFakeLibvirtState(statePath, releaseId) {
  const prior = readFakeLibvirtState(statePath);
  writeFileSync(
    statePath,
    `${JSON.stringify({
      ...prior,
      definedReleaseId: releaseId,
      history: [...prior.history, releaseId],
    })}\n`,
  );
}

function finalReleaseIds(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => !entry.startsWith("."))
    .sort();
}

function fileSnapshot(path) {
  const metadata = statSync(path, { bigint: true });
  return {
    bytes: readFileSync(path, "hex"),
    inode: metadata.ino,
    mtimeNs: metadata.mtimeNs,
  };
}

function releaseSnapshot(layout, release) {
  const paths = [
    layout.currentManifestPath,
    release.manifestPath,
    release.systemPath,
    release.cachePath,
    release.domainXmlPath,
    release.diagnosticPath,
  ];
  return Object.fromEntries(paths.map((path) => [path, fileSnapshot(path)]));
}

function configureCrossFilesystemCache(config, root, label) {
  const cacheParent = "/dev/shm";
  if (
    !existsSync(cacheParent) ||
    statSync(root).dev === statSync(cacheParent).dev
  ) {
    return null;
  }
  const cacheRoot = join(
    cacheParent,
    `vem-kvm-baseline-sigkill-${process.pid}-${Date.now()}-${label}`,
  );
  config.host.largeFileRoot = "/";
  config.storage.cacheDiskPath = join(cacheRoot, "win10-runtime-cache.qcow2");
  return cacheRoot;
}

function publicationKillChildSource() {
  return `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  publishVerifiedBaselineRelease,
  runtimeProfileForPublishedRelease,
} from ${JSON.stringify(new URL("./linux-kvm-baseline.mjs", import.meta.url).href)};

const [configurationPath, faultStage, statePath] = process.argv.slice(2);
if (!configurationPath || !faultStage || !statePath) {
  throw new Error("usage: child <config> <stage> <fake-libvirt-state>");
}
const config = JSON.parse(await readFile(configurationPath, "utf8"));
const releaseId = "release-new-sigkill";
const systemDirectory = join(
  dirname(config.storage.baselinePath),
  ".release-kill-system-" + faultStage + "-" + process.pid,
);
const cacheDirectory = join(
  dirname(config.storage.cacheDiskPath),
  ".release-kill-cache-" + faultStage + "-" + process.pid,
);
const staged = {
  system: join(systemDirectory, "system.qcow2"),
  cache: join(cacheDirectory, "cache.qcow2"),
  domainXml: join(systemDirectory, "runtime-profile.xml"),
  diagnostic: join(systemDirectory, "diagnostic.json"),
};
await mkdir(systemDirectory, { recursive: true });
await mkdir(cacheDirectory, { recursive: true });
await Promise.all([
  writeFile(staged.system, "new-system"),
  writeFile(staged.cache, "new-cache"),
  writeFile(staged.domainXml, "<domain>new</domain>"),
  writeFile(staged.diagnostic, '{"contents":"new"}\\n'),
]);
const writeFakeDefinition = async (release) => {
  const prior = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    JSON.stringify({
      ...prior,
      definedReleaseId: release?.releaseId ?? null,
      history: [...prior.history, release?.releaseId ?? null],
    }) + "\\n",
  );
};
await publishVerifiedBaselineRelease({
  config,
  releaseId,
  stagedSystemPath: staged.system,
  stagedCachePath: staged.cache,
  stagedDomainXmlPath: staged.domainXml,
  stagedDiagnosticPath: staged.diagnostic,
  profile: runtimeProfileForPublishedRelease(config, releaseId),
  verified: true,
  commitDefinition: writeFakeDefinition,
  rollbackDefinition: writeFakeDefinition,
  onStage: async (stage) => {
    if (stage === faultStage) process.kill(process.pid, "SIGKILL");
  },
});
`;
}

function runPublicationKillChild(root, configPath, faultStage, statePath) {
  const childPath = join(root, "kvm-baseline-publication-kill-child.mjs");
  writeFileSync(childPath, publicationKillChildSource());
  return spawnSync(
    process.execPath,
    [childPath, configPath, faultStage, statePath],
    { encoding: "utf8" },
  );
}

async function recoverWithFakeLibvirt(config, statePath) {
  return recoverPublishedBaseline(config, {
    recoverDefinition: async (release) => {
      assert.match(
        readFileSync(release.systemPath, "utf8"),
        /^(old|new)-system$/,
      );
      assert.match(
        readFileSync(release.cachePath, "utf8"),
        /^(old|new)-cache$/,
      );
      writeFakeLibvirtState(statePath, release.releaseId);
    },
    rollbackDefinition: async (release) =>
      writeFakeLibvirtState(statePath, release?.releaseId ?? null),
  });
}

function expectedSigkillRelease(stage, hasPriorCurrent) {
  const currentPublicationStages = new Set([
    "current-manifest-renamed",
    "current-manifest-published",
  ]);
  if (hasPriorCurrent) {
    return currentPublicationStages.has(stage)
      ? "release-new-sigkill"
      : "release-old-sigkill";
  }
  return stage === "system-release-directory-renamed" ||
    BASELINE_PUBLICATION_STAGES.indexOf(stage) >=
      BASELINE_PUBLICATION_STAGES.indexOf("system-release-directory-published")
    ? "release-new-sigkill"
    : null;
}

function completedInteractiveDisplayStatus(bootIdentity = "boot-complete") {
  return {
    schemaVersion: "win10-kvm-interactive-display-status/v1",
    reportPresent: true,
    reportValid: true,
    state: { phase: "complete" },
    task: null,
    cleanup: {
      taskRemoved: true,
      spiceGuestToolsResumeRemoved: true,
      automaticLogonDisabled: true,
    },
    currentBootIdentity: bootIdentity,
  };
}

function bindWindowsOpenSshPowerShellCommand(command) {
  assert.doesNotMatch(command, /['"&|<>^`]/);
  const argv = command.split(" ");
  assert.deepEqual(argv.slice(0, -1), [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]);
  assert.match(argv.at(-1), /^[A-Za-z0-9+/=]+$/);
  const script = Buffer.from(argv.at(-1), "base64").toString("utf16le");
  const request = /FromBase64String\("([A-Za-z0-9+/=]+)"\)/.exec(script);
  assert.ok(
    request,
    "encoded script must bind its JSON request through Base64",
  );
  return {
    argv,
    script,
    parameters: JSON.parse(Buffer.from(request[1], "base64").toString("utf8")),
  };
}

function interactiveDisplayReport(config) {
  return {
    schemaVersion: "win10-kvm-interactive-display/v1",
    interactiveUser: `KVM-BUILDER\\${config.guest.sshUser}`,
    interactiveSessionId: 1,
    desktop: {
      width: 1080,
      height: 1920,
      scalePercent: config.guest.desktopScalePercent,
    },
    qxlDisplayAdapter: "Red Hat QXL controller",
  };
}

function constructionSignalCleanupChildSource() {
  return `
import { mkdir, rm, writeFile } from "node:fs/promises";
import { runWithConstructionSignalCleanup } from ${JSON.stringify(
    new URL("./build-win10-baseline.mjs", import.meta.url).href,
  )};

const [domainName, domainPath, systemStagingPath, cacheStagingPath, receiptPath, readyPath] = process.argv.slice(2);
await Promise.all([
  mkdir(domainPath, { recursive: true }),
  mkdir(systemStagingPath, { recursive: true }),
  mkdir(cacheStagingPath, { recursive: true }),
]);
await runWithConstructionSignalCleanup({
  cleanup: async () => {
    await Promise.all([
      rm(domainPath, { recursive: true, force: true }),
      rm(systemStagingPath, { recursive: true, force: true }),
      rm(cacheStagingPath, { recursive: true, force: true }),
    ]);
    await writeFile(receiptPath, JSON.stringify({ domainName, systemStagingPath, cacheStagingPath }));
  },
  exitOnSignal: true,
  work: async () => {
    await writeFile(readyPath, "ready");
    await new Promise(() => setInterval(() => {}, 1_000));
  },
});
`;
}

const REQUIRED_PRE_PHASE_KILL_STAGES = Object.freeze([
  "cache-release-directory-renamed",
  "system-release-directory-renamed",
  "libvirt-definition-mutated",
  "current-manifest-renamed",
]);

describe("Linux KVM Windows baseline", () => {
  it("exposes a loadable builder that is inert unless explicitly executed", () => {
    assert.equal(typeof buildWin10Baseline, "function");
  });

  it("defines the portable portrait runtime profile without host-specific defaults", () => {
    const profile = createRuntimeProfile({
      vmName: "win10-runtime-baseline",
      systemDiskPath: "/srv/vm/win10.qcow2",
      cacheDiskPath: "/srv/vm/win10-cache.qcow2",
      networkName: "runtime-testbed",
      macAddress: "52:54:00:12:34:56",
    });

    assert.equal(profile.vcpus, 8);
    assert.equal(profile.memoryMiB, 16 * 1024);
    assert.deepEqual(profile.display, {
      width: 1080,
      height: 1920,
      scalePercent: 100,
      videoMemoryKiB: 65536,
    });
    assert.deepEqual(profile.serialRoles, ["lower-controller", "scanner"]);
    assert.equal(profile.audio.defaultDevice, true);
    assert.equal(profile.disks.system.resettable, true);
    assert.equal(profile.disks.cache.persistent, true);
    assert.equal(profile.network.macAddress, "52:54:00:12:34:56");

    const xml = renderLibvirtDomainXml(profile, {
      cdromPaths: ["/srv/media/windows.iso", "/srv/media/config.iso"],
    });
    assert.match(xml, /<memory unit="MiB">16384<\/memory>/);
    assert.match(
      xml,
      /<model type="qxl" ram="65536" vram="65536" vgamem="16384" heads="1" primary="yes"><resolution x="1080" y="1920"\/><\/model>/,
    );
    assert.match(xml, /target type="usb-serial" port="0"/);
    assert.match(xml, /<address type="usb" bus="0" port="1"\/>/);
    assert.match(xml, /<address type="usb" bus="0" port="2"\/>/);
    assert.match(xml, /<sound model="ich9"\/>/);
    assert.match(xml, /<mac address="52:54:00:12:34:56"\/>/);
    assert.match(xml, /target dev="sdc" bus="sata"/);
    assert.match(xml, /target dev="sdd" bus="sata"/);
    assert.doesNotMatch(xml, /device="cdrom"[\s\S]*target dev="sd[ab]"/);
    assert.doesNotMatch(xml, /192\.168\.2\.22|\/mnt\/user|Unraid/i);
    const parsed = spawnSync("xmllint", ["--noout", "-"], {
      input: xml,
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);

    const alternateProfile = createRuntimeProfile({
      vmName: "win10-runtime-baseline",
      systemDiskPath: "/srv/vm/win10.qcow2",
      cacheDiskPath: "/srv/vm/win10-cache.qcow2",
      networkName: "runtime-testbed",
      macAddress: "52:54:00:12:34:56",
      display: { width: 1200, height: 1600 },
    });
    assert.match(
      renderLibvirtDomainXml(alternateProfile),
      /<resolution x="1200" y="1600"\/>/,
    );
  });

  it("verifies the defined ICH9/SPICE backend and exact USB-port serial role mapping", () => {
    const profile = createRuntimeProfile({
      vmName: "win10-runtime-baseline",
      systemDiskPath: "/srv/vm/win10.qcow2",
      cacheDiskPath: "/srv/vm/win10-cache.qcow2",
      networkName: "runtime-testbed",
      macAddress: "52:54:00:12:34:56",
    });
    const xml = renderLibvirtDomainXml(profile);

    assert.deepEqual(verifyDefinedRuntimeDevices(xml, profile), {
      audio: { model: "ich9", backend: "spice", defaultDevice: true },
      serialRoles: ["lower-controller", "scanner"],
      serialUsbPorts: [1, 2],
    });
    assert.throws(
      () =>
        verifyDefinedRuntimeDevices(
          xml.replace('<sound model="ich9"/>', '<sound model="ac97"/>'),
          profile,
        ),
      /default ICH9 audio device/,
    );
    assert.throws(
      () =>
        verifyDefinedRuntimeDevices(
          xml.replace(
            'address type="usb" bus="0" port="2"',
            'address type="usb" bus="0" port="1"',
          ),
          profile,
        ),
      /USB serial role scanner is invalid/,
    );
    assert.doesNotThrow(() =>
      verifyDefinedRuntimeDevices(
        xml.replaceAll(/\s*<alias name="serial-[^"]+"\/>/g, ""),
        profile,
      ),
    );
  });

  it("keeps published cache sidecars on storage.cacheDiskPath while retaining one release manifest", () => {
    const root = "/var/tmp/vem-kvm-baseline";
    const config = buildConfig(root);
    config.storage.cacheDiskPath = "/var/cache/vem/win10-runtime-cache.qcow2";
    config.host.largeFileRoot = "/";
    const layout = baselinePublicationLayout(config);
    const release = runtimeProfileForPublishedRelease(
      config,
      "release-cache-root",
    );

    assert.equal(
      layout.systemReleaseRoot,
      `${config.storage.baselinePath}.releases`,
    );
    assert.equal(
      layout.cacheReleaseRoot,
      `${config.storage.cacheDiskPath}.releases`,
    );
    assert.equal(
      layout.currentManifestPath,
      `${config.storage.baselinePath}.current.json`,
    );
    assert.match(
      release.disks.system.path,
      /^\/var\/tmp\/vem-kvm-baseline\/images\/win10-runtime-baseline\.qcow2\.releases\//,
    );
    assert.match(
      release.disks.cache.path,
      /^\/var\/cache\/vem\/win10-runtime-cache\.qcow2\.releases\//,
    );
    assert.deepEqual(
      runtimeProfileForConfig(config).disks.cache.path,
      config.storage.cacheDiskPath,
    );
  });

  it("requires caller-owned identity, storage, media, network, and runner inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-config-"));
    try {
      const config = buildConfig(root);
      assert.deepEqual(validateBaselineBuildConfig(config), config);

      delete config.runner.registrationTokenProvider;
      assert.throws(
        () => validateBaselineBuildConfig(config),
        /runner\.registrationTokenProvider/,
      );

      const missingSpiceInstaller = buildConfig(root);
      delete missingSpiceInstaller.media.spiceGuestToolsInstallerPath;
      assert.throws(
        () => validateBaselineBuildConfig(missingSpiceInstaller),
        /media\.spiceGuestToolsInstallerPath/,
      );

      const missingRunnerArchive = buildConfig(root);
      delete missingRunnerArchive.media.runnerArchivePath;
      assert.throws(
        () => validateBaselineBuildConfig(missingRunnerArchive),
        /media\.runnerArchivePath/,
      );

      const invalidRunnerArchiveHash = buildConfig(root);
      invalidRunnerArchiveHash.media.runnerArchiveSha256 = "not-a-sha256";
      assert.throws(
        () => validateBaselineBuildConfig(invalidRunnerArchiveHash),
        /media\.runnerArchiveSha256/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a host that cannot satisfy KVM, libvirt, media, or requested resources", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-preflight-"));
    try {
      const config = buildConfig(root);
      assert.throws(
        () =>
          evaluateHostPreflight(config, {
            hostIdentity: hostIdentity(),
            kvmAvailable: false,
            libvirtAvailable: true,
            commands: [
              "virsh",
              "virt-install",
              "qemu-img",
              "xorriso",
              "ssh",
              "scp",
              "flock",
            ],
            cpuCount: 32,
            availableMemoryMiB: 64 * 1024,
            availableStorageBytes: 200 * 1024 ** 3,
            installationMedia: {
              windowsIso: true,
              spiceGuestToolsInstaller: true,
              runnerArchive: true,
            },
            networkActive: true,
            storageAvailableBytes: {
              baseline: 200 * 1024 ** 3,
              cache: 200 * 1024 ** 3,
            },
          }),
        /KVM/,
      );
      assert.throws(
        () =>
          evaluateHostPreflight(config, {
            hostIdentity: hostIdentity(),
            kvmAvailable: true,
            libvirtAvailable: true,
            commands: [
              "virsh",
              "virt-install",
              "qemu-img",
              "xorriso",
              "ssh",
              "scp",
              "flock",
            ],
            cpuCount: 8,
            availableMemoryMiB: 16 * 1024,
            availableStorageBytes: 79 * 1024 ** 3,
            installationMedia: {
              windowsIso: true,
              spiceGuestToolsInstaller: true,
              runnerArchive: true,
            },
            networkActive: true,
            storageAvailableBytes: {
              baseline: 79 * 1024 ** 3,
              cache: 79 * 1024 ** 3,
            },
          }),
        /storage/,
      );
      assert.deepEqual(
        evaluateHostPreflight(config, {
          hostIdentity: hostIdentity(),
          kvmAvailable: true,
          libvirtAvailable: true,
          commands: [
            "virsh",
            "virt-install",
            "qemu-img",
            "xorriso",
            "ssh",
            "scp",
            "flock",
          ],
          cpuCount: 8,
          availableMemoryMiB: 16 * 1024,
          availableStorageBytes: 80 * 1024 ** 3,
          installationMedia: {
            windowsIso: true,
            spiceGuestToolsInstaller: true,
            runnerArchive: true,
          },
          networkActive: true,
          storageAvailableBytes: {
            baseline: 80 * 1024 ** 3,
            cache: 80 * 1024 ** 3,
          },
        }),
        { ok: true },
      );
      assert.throws(
        () =>
          evaluateHostPreflight(config, {
            hostIdentity: {
              hostnames: ["another-host.example.test"],
              addresses: ["192.0.2.11"],
              resolvedConfiguredAddresses: ["192.0.2.12"],
            },
            kvmAvailable: true,
            libvirtAvailable: true,
            commands: [
              "virsh",
              "virt-install",
              "qemu-img",
              "xorriso",
              "ssh",
              "scp",
              "flock",
            ],
            cpuCount: 8,
            availableMemoryMiB: 16 * 1024,
            installationMedia: {
              windowsIso: true,
              spiceGuestToolsInstaller: true,
              runnerArchive: true,
            },
            networkActive: true,
            storageAvailableBytes: {
              baseline: 80 * 1024 ** 3,
              cache: 80 * 1024 ** 3,
            },
          }),
        /host\.address must identify the executing host/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unverified release publication before it can create a current manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-unverified-"));
    try {
      const config = buildConfig(root);
      const staged = stagedRelease(config, "unverified", "new");
      await assert.rejects(
        publishVerifiedBaselineRelease({
          config,
          releaseId: "release-unverified",
          stagedSystemPath: staged.system,
          stagedCachePath: staged.cache,
          stagedDomainXmlPath: staged.domainXml,
          stagedDiagnosticPath: staged.diagnostic,
          profile: {},
          verified: false,
        }),
        /verification/,
      );
      assert.equal(
        existsSync(baselinePublicationLayout(config).currentManifestPath),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the selected release and restores its definition when final libvirt definition fails", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-define-failure-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-old-defined",
        "old",
      );
      const staged = stagedRelease(config, "define-failure", "new");
      const operations = [];

      await assert.rejects(
        publishVerifiedBaselineRelease({
          config,
          releaseId: "release-new-define-failure",
          stagedSystemPath: staged.system,
          stagedCachePath: staged.cache,
          stagedDomainXmlPath: staged.domainXml,
          stagedDiagnosticPath: staged.diagnostic,
          profile: runtimeProfileForPublishedRelease(
            config,
            "release-new-define-failure",
          ),
          verified: true,
          commitDefinition: async (release) => {
            operations.push(`define:${release.releaseId}`);
            throw new Error("simulated virsh define failure");
          },
          rollbackDefinition: async (release) => {
            operations.push(`restore:${release.releaseId}`);
          },
        }),
        /simulated virsh define failure/,
      );

      assert.deepEqual(operations, [
        "define:release-new-define-failure",
        `restore:${oldRelease.releaseId}`,
      ]);
      assert.equal(
        (await resolvePublishedBaselineRelease(config)).releaseId,
        oldRelease.releaseId,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not roll back a successful final definition after the current manifest publishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-post-publish-"));
    try {
      const config = buildConfig(root);
      await publishRelease(config, "release-old-post-publish", "old");
      const staged = stagedRelease(config, "post-publish", "new");
      const operations = [];

      await assert.rejects(
        publishVerifiedBaselineRelease({
          config,
          releaseId: "release-new-post-publish",
          stagedSystemPath: staged.system,
          stagedCachePath: staged.cache,
          stagedDomainXmlPath: staged.domainXml,
          stagedDiagnosticPath: staged.diagnostic,
          profile: runtimeProfileForPublishedRelease(
            config,
            "release-new-post-publish",
          ),
          verified: true,
          commitDefinition: async (release) => {
            operations.push(`define:${release.releaseId}`);
          },
          rollbackDefinition: async (release) => {
            operations.push(`restore:${release.releaseId}`);
          },
          onStage: async (stage) => {
            if (stage === "current-manifest-published") {
              throw new Error("simulated post-publication failure");
            }
          },
        }),
        /simulated post-publication failure/,
      );

      assert.deepEqual(operations, ["define:release-new-post-publish"]);
      assert.equal(
        (await resolvePublishedBaselineRelease(config)).releaseId,
        "release-new-post-publish",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a legacy definition intent only after re-verifying the selected current release", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-define-recovery-"),
    );
    try {
      const config = buildConfig(root);
      const release = await publishRelease(
        config,
        "release-define-recovery",
        "old",
      );
      const layout = baselinePublicationLayout(config);
      writeFileSync(
        layout.publicationJournalPath,
        JSON.stringify({
          schemaVersion: "win10-kvm-baseline-publication-intent/v1",
          previousReleaseId: release.releaseId,
          releaseId: "release-uncommitted-definition",
        }),
      );
      const definitions = [];

      const recovered = await recoverPublishedBaseline(config, {
        recoverDefinition: async (selected, intent) => {
          definitions.push({ selected: selected.releaseId, intent });
        },
        rollbackDefinition: async () => {},
      });

      assert.equal(recovered.releaseId, release.releaseId);
      assert.deepEqual(definitions, [
        {
          selected: release.releaseId,
          intent: {
            schemaVersion: "win10-kvm-baseline-publication-journal/v2",
            previousReleaseId: release.releaseId,
            releaseId: "release-uncommitted-definition",
            phase: "definition-intent-staged",
          },
        },
      ]);
      assert.equal(existsSync(layout.publicationJournalPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires staged system and cache artifacts to reside on their respective publication filesystems", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-sidecar-fs-"));
    const cacheRoot = "/dev/shm";
    let cacheReleaseRoot = null;
    try {
      if (statSync(root).dev === statSync(cacheRoot).dev) return;
      const config = buildConfig(root);
      config.host.largeFileRoot = "/";
      config.storage.cacheDiskPath = join(
        cacheRoot,
        `vem-kvm-cache-${process.pid}-${Date.now()}.qcow2`,
      );
      cacheReleaseRoot = `${config.storage.cacheDiskPath}.releases`;
      const staged = stagedRelease(config, "wrong-cache-filesystem", "new");
      const wrongCachePath = join(dirname(staged.system), "wrong-cache.qcow2");
      writeFileSync(wrongCachePath, "wrong-cache");

      await assert.rejects(
        publishVerifiedBaselineRelease({
          config,
          releaseId: "release-wrong-cache-filesystem",
          stagedSystemPath: staged.system,
          stagedCachePath: wrongCachePath,
          stagedDomainXmlPath: staged.domainXml,
          stagedDiagnosticPath: staged.diagnostic,
          profile: runtimeProfileForPublishedRelease(
            config,
            "release-wrong-cache-filesystem",
          ),
          verified: true,
          commitDefinition: async () => {},
          rollbackDefinition: async () => {},
        }),
        /cache publication filesystem/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (cacheReleaseRoot) {
        rmSync(cacheReleaseRoot, { recursive: true, force: true });
      }
    }
  });

  it("preserves an established current release when journal-absent definition verification transiently fails", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-current-verification-failure-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-current-verification-failure",
        "old",
      );
      const layout = baselinePublicationLayout(config);
      const before = releaseSnapshot(layout, oldRelease);
      let rollbackCalled = false;

      await assert.rejects(
        recoverPublishedBaseline(config, {
          recoverDefinition: async (release) => {
            assert.equal(release.releaseId, oldRelease.releaseId);
            throw new Error("simulated transient libvirt verification failure");
          },
          rollbackDefinition: async () => {
            rollbackCalled = true;
          },
        }),
        /transient libvirt verification failure/,
      );

      assert.equal(rollbackCalled, false);
      assert.deepEqual(releaseSnapshot(layout, oldRelease), before);
      assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), [
        oldRelease.releaseId,
      ]);
      assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), [
        oldRelease.releaseId,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back a first publication when recovered definition verification fails", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-first-recovery-"),
    );
    try {
      const config = buildConfig(root);
      const layout = baselinePublicationLayout(config);
      const configPath = join(root, "config.json");
      const statePath = join(root, "fake-libvirt.json");
      writeFileSync(statePath, '{"definedReleaseId":null,"history":[]}\n');
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const child = runPublicationKillChild(
        root,
        configPath,
        "libvirt-definition-mutated",
        statePath,
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);

      await assert.rejects(
        recoverPublishedBaseline(config, {
          recoverDefinition: async () => {
            throw new Error(
              "simulated recovered definition verification failure",
            );
          },
          rollbackDefinition: async (release) =>
            writeFakeLibvirtState(statePath, release?.releaseId ?? null),
        }),
        /verification failure/,
      );
      assert.equal(existsSync(layout.currentManifestPath), false);
      assert.equal(readFakeLibvirtState(statePath).definedReleaseId, null);
      assert.equal(existsSync(layout.publicationJournalPath), false);
      assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), []);
      assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans a truncated journal and an unmatched cache sidecar without blocking a valid current release", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-journal-repair-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-journal-old",
        "old",
      );
      const layout = baselinePublicationLayout(config);
      const statePath = join(root, "fake-libvirt.json");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          definedReleaseId: oldRelease.releaseId,
          history: [oldRelease.releaseId],
        })}\n`,
      );
      const orphanId = "release-orphan-sidecar";
      const orphanCacheDirectory = join(layout.cacheReleaseRoot, orphanId);
      mkdirSync(orphanCacheDirectory, { recursive: true });
      writeFileSync(join(orphanCacheDirectory, "cache.qcow2"), "orphan-cache");
      writeFileSync(layout.publicationJournalPath, '{"schemaVersion":');

      const recovered = await recoverWithFakeLibvirt(config, statePath);

      assert.equal(recovered.releaseId, oldRelease.releaseId);
      assert.equal(existsSync(layout.publicationJournalPath), false);
      assert.equal(existsSync(orphanCacheDirectory), false);
      assert.equal(
        readFakeLibvirtState(statePath).definedReleaseId,
        oldRelease.releaseId,
      );
      assert.deepEqual(
        finalReleaseIds(layout.systemReleaseRoot),
        finalReleaseIds(layout.cacheReleaseRoot),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const hasPriorCurrent of [true, false]) {
    it(`${hasPriorCurrent ? "restores the prior release" : "preserves unselected first-publication artifacts"} after a truncated post-definition journal with ${hasPriorCurrent ? "a prior current" : "no prior current"}`, async () => {
      const root = mkdtempSync(
        join(tmpdir(), "vem-kvm-baseline-truncated-definition-"),
      );
      try {
        const config = buildConfig(root);
        const configPath = join(root, "config.json");
        const statePath = join(root, "fake-libvirt.json");
        writeFileSync(statePath, '{"definedReleaseId":null,"history":[]}\n');
        let oldRelease = null;
        if (hasPriorCurrent) {
          oldRelease = await publishRelease(
            config,
            "release-old-truncated-definition",
            "old",
          );
          writeFakeLibvirtState(statePath, oldRelease.releaseId);
        }
        writeFileSync(configPath, `${JSON.stringify(config)}\n`);

        const child = runPublicationKillChild(
          root,
          configPath,
          "libvirt-definition-committed",
          statePath,
        );
        assert.equal(child.signal, "SIGKILL", child.stderr);

        const layout = baselinePublicationLayout(config);
        writeFileSync(layout.publicationJournalPath, '{"schemaVersion":');

        if (!hasPriorCurrent) {
          await assert.rejects(
            recoverWithFakeLibvirt(config, statePath),
            /no verifiable selected release/,
          );
          assert.equal(
            readFakeLibvirtState(statePath).definedReleaseId,
            "release-new-sigkill",
          );
          assert.equal(existsSync(layout.currentManifestPath), false);
          assert.equal(existsSync(layout.publicationJournalPath), true);
          assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), [
            "release-new-sigkill",
          ]);
          assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), [
            "release-new-sigkill",
          ]);
          return;
        }

        const recovered = await recoverWithFakeLibvirt(config, statePath);

        const expectedReleaseId = oldRelease.releaseId;
        assert.equal(recovered?.releaseId ?? null, expectedReleaseId);
        assert.equal(
          readFakeLibvirtState(statePath).definedReleaseId,
          expectedReleaseId,
        );
        assert.equal(
          existsSync(layout.currentManifestPath),
          expectedReleaseId !== null,
        );
        assert.equal(existsSync(layout.publicationJournalPath), false);
        assert.deepEqual(
          finalReleaseIds(layout.systemReleaseRoot),
          expectedReleaseId === null ? [] : [expectedReleaseId],
        );
        assert.deepEqual(
          finalReleaseIds(layout.cacheReleaseRoot),
          expectedReleaseId === null ? [] : [expectedReleaseId],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("rolls current back when recovered new-definition verification restores the previous libvirt definition", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-recovered-definition-failure-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-old-recovered-definition-failure",
        "old",
      );
      const configPath = join(root, "config.json");
      const statePath = join(root, "fake-libvirt.json");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          definedReleaseId: oldRelease.releaseId,
          history: [oldRelease.releaseId],
        })}\n`,
      );
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);

      const child = runPublicationKillChild(
        root,
        configPath,
        "current-manifest-renamed",
        statePath,
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);

      const layout = baselinePublicationLayout(config);
      await assert.rejects(
        recoverPublishedBaseline(config, {
          recoverDefinition: async (release) => {
            assert.equal(release.releaseId, "release-new-sigkill");
            throw new Error(
              "simulated recovered definition verification failure",
            );
          },
          rollbackDefinition: async (release) =>
            writeFakeLibvirtState(statePath, release?.releaseId ?? null),
        }),
        /verification failure/,
      );

      assert.equal(
        (await resolvePublishedBaselineRelease(config)).releaseId,
        oldRelease.releaseId,
      );
      assert.equal(
        readFakeLibvirtState(statePath).definedReleaseId,
        oldRelease.releaseId,
      );
      assert.equal(existsSync(layout.publicationJournalPath), false);
      assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), [
        oldRelease.releaseId,
      ]);
      assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), [
        oldRelease.releaseId,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a truncated journal from the durable prior release after new-definition verification keeps failing", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-truncated-current-new-old-libvirt-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-old-truncated-current",
        "old",
      );
      const configPath = join(root, "config.json");
      const statePath = join(root, "fake-libvirt.json");
      writeFileSync(
        statePath,
        `${JSON.stringify({
          definedReleaseId: oldRelease.releaseId,
          history: [oldRelease.releaseId],
        })}\n`,
      );
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);

      const child = runPublicationKillChild(
        root,
        configPath,
        "current-manifest-renamed",
        statePath,
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);

      const layout = baselinePublicationLayout(config);
      writeFakeLibvirtState(statePath, oldRelease.releaseId);
      writeFileSync(layout.publicationJournalPath, '{"schemaVersion":');

      const attemptedDefinitions = [];
      await assert.rejects(
        recoverPublishedBaseline(config, {
          recoverDefinition: async (release) => {
            attemptedDefinitions.push(release.releaseId);
            if (release.releaseId === "release-new-sigkill") {
              throw new Error("simulated persistent new-definition failure");
            }
            assert.equal(release.releaseId, oldRelease.releaseId);
            writeFakeLibvirtState(statePath, release.releaseId);
          },
          rollbackDefinition: async (release) => {
            assert.equal(release?.releaseId, oldRelease.releaseId);
            writeFakeLibvirtState(statePath, release.releaseId);
          },
        }),
        /persistent new-definition failure/,
      );

      assert.deepEqual(attemptedDefinitions, ["release-new-sigkill"]);
      assert.equal(
        (await resolvePublishedBaselineRelease(config)).releaseId,
        oldRelease.releaseId,
      );
      assert.equal(
        readFakeLibvirtState(statePath).definedReleaseId,
        oldRelease.releaseId,
      );
      assert.equal(existsSync(layout.publicationJournalPath), false);
      assert.equal(existsSync(layout.previousReleasePath), false);
      assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), [
        oldRelease.releaseId,
      ]);
      assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), [
        oldRelease.releaseId,
      ]);

      const recoveredAgain = await recoverWithFakeLibvirt(config, statePath);
      assert.equal(recoveredAgain.releaseId, oldRelease.releaseId);
      assert.deepEqual(finalReleaseIds(layout.systemReleaseRoot), [
        oldRelease.releaseId,
      ]);
      assert.deepEqual(finalReleaseIds(layout.cacheReleaseRoot), [
        oldRelease.releaseId,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const hasPriorCurrent of [true, false]) {
    for (const interruptedStage of new Set([
      ...BASELINE_PUBLICATION_STAGES,
      ...REQUIRED_PRE_PHASE_KILL_STAGES,
    ])) {
      it(`recovers an actual child SIGKILL at ${interruptedStage} with ${hasPriorCurrent ? "a prior current" : "no prior current"}`, async (t) => {
        const root = mkdtempSync(
          join(tmpdir(), "vem-kvm-baseline-publish-sigkill-"),
        );
        let cacheRoot = null;
        try {
          const config = buildConfig(root);
          cacheRoot = configureCrossFilesystemCache(
            config,
            root,
            `${hasPriorCurrent}-${interruptedStage}`,
          );
          if (!cacheRoot) {
            t.skip("a separate /dev/shm filesystem is unavailable");
            return;
          }
          const configPath = join(root, "config.json");
          const statePath = join(root, "fake-libvirt.json");
          writeFileSync(statePath, '{"definedReleaseId":null,"history":[]}\n');
          let oldRelease = null;
          if (hasPriorCurrent) {
            oldRelease = await publishRelease(
              config,
              "release-old-sigkill",
              "old",
            );
            writeFakeLibvirtState(statePath, oldRelease.releaseId);
          }
          writeFileSync(configPath, `${JSON.stringify(config)}\n`);

          const child = runPublicationKillChild(
            root,
            configPath,
            interruptedStage,
            statePath,
          );
          assert.equal(child.signal, "SIGKILL", child.stderr);

          const recovered = await recoverWithFakeLibvirt(config, statePath);
          const expectedReleaseId = expectedSigkillRelease(
            interruptedStage,
            hasPriorCurrent,
          );
          const layout = baselinePublicationLayout(config);
          if (expectedReleaseId === null) {
            assert.equal(recovered, null);
            assert.equal(existsSync(layout.currentManifestPath), false);
          } else {
            assert.equal(recovered.releaseId, expectedReleaseId);
            assert.equal(
              readFileSync(recovered.systemPath, "utf8"),
              expectedReleaseId === "release-new-sigkill"
                ? "new-system"
                : "old-system",
            );
            assert.equal(
              readFileSync(recovered.cachePath, "utf8"),
              expectedReleaseId === "release-new-sigkill"
                ? "new-cache"
                : "old-cache",
            );
            assert.equal(
              (await resolvePublishedBaselineRelease(config)).releaseId,
              expectedReleaseId,
            );
          }
          assert.equal(
            readFakeLibvirtState(statePath).definedReleaseId,
            expectedReleaseId,
          );
          assert.equal(existsSync(layout.publicationJournalPath), false);
          assert.deepEqual(
            finalReleaseIds(layout.systemReleaseRoot),
            finalReleaseIds(layout.cacheReleaseRoot),
            "recovery must leave no orphan cache or system sidecar",
          );
          for (const releaseRoot of [
            layout.systemReleaseRoot,
            layout.cacheReleaseRoot,
          ]) {
            assert.equal(
              readdirSync(releaseRoot).some((entry) =>
                entry.startsWith(".staging-"),
              ),
              false,
            );
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
          if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
        }
      });
    }
  }

  it("renders a fully unattended zh-CN Windows 10 22H2 installation without retired OOBE skips", () => {
    const config = buildConfig("/var/tmp/vem-kvm-baseline");
    const xml = renderUnattendedXml({
      ...config,
      __secrets: { administratorPassword: "test-password" },
    });

    assert.match(xml, /Microsoft-Windows-International-Core-WinPE/);
    assert.match(xml, /Microsoft-Windows-International-Core/);
    assert.match(xml, /<InputLocale>zh-CN<\/InputLocale>/);
    assert.match(xml, /<SystemLocale>zh-CN<\/SystemLocale>/);
    assert.match(xml, /<UILanguage>zh-CN<\/UILanguage>/);
    assert.match(xml, /<UserLocale>zh-CN<\/UserLocale>/);
    assert.match(
      xml,
      /<HideOnlineAccountScreens>true<\/HideOnlineAccountScreens>/,
    );
    assert.match(
      xml,
      /<HideWirelessSetupInOOBE>true<\/HideWirelessSetupInOOBE>/,
    );
    assert.match(xml, /<LogonCount>2<\/LogonCount>/);
    assert.match(xml, /<settings pass="specialize">/);
    assert.match(xml, /Microsoft-Windows-Deployment/);
    assert.match(xml, /C:\\ProgramData\\WindowsRuntimeBaseline\\media/);
    const specializeCommand =
      /<settings pass="specialize">[\s\S]*?<Path>([^<]+)<\/Path>/.exec(
        xml,
      )?.[1];
    assert.ok(specializeCommand);
    assert.ok(
      specializeCommand.length < 260,
      "specialize RunSynchronous Path must fit the Win10 WCM scalar limit",
    );
    assert.match(
      specializeCommand,
      /if exist %d:\\baseline-config\.json xcopy/,
    );
    assert.doesNotMatch(specializeCommand, /Win32_CDROMDrive|Get-Volume/);
    assert.match(
      xml,
      /-File &quot;C:\\ProgramData\\WindowsRuntimeBaseline\\media\\bootstrap\.ps1&quot;/,
    );
    assert.match(
      xml,
      /<ProductKey><Key>W269N-WFGWX-YVC9B-4J6C9-T83GX<\/Key><WillShowUI>Never<\/WillShowUI><\/ProductKey>/,
    );
    assert.doesNotMatch(xml, /SkipMachineOOBE/i);
    const parsed = spawnSync("xmllint", ["--noout", "-"], {
      input: xml,
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  });

  it("copies the caller-provided pinned SPICE installer into configuration media", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-config-media-"));
    try {
      const config = buildConfig(root);
      mkdirSync(dirname(config.guest.administratorPasswordFile), {
        recursive: true,
      });
      mkdirSync(dirname(config.media.spiceGuestToolsInstallerPath), {
        recursive: true,
      });
      writeFileSync(config.guest.administratorPasswordFile, "test-password\n");
      writeFileSync(config.guest.authorizedKeysFile, "ssh-ed25519 test\n");
      writeFileSync(config.media.spiceGuestToolsInstallerPath, "spice-tools");
      writeFileSync(config.media.runnerArchivePath, "runner-archive");
      config.media.runnerArchiveSha256 = createHash("sha256")
        .update("runner-archive")
        .digest("hex");
      const commands = [];
      const stagingDirectory = join(root, "staging");
      await createConfigurationMedia(config, stagingDirectory, {
        runCommand: async (...command) => commands.push(command),
      });

      const mediaRoot = join(stagingDirectory, "configuration-media");
      assert.deepEqual(guestConfigurationFor(config), {
        webView2InstallerUri: config.media.webView2InstallerUri,
        spiceGuestToolsInstallerFile: SPICE_GUEST_TOOLS_INSTALLER_FILE,
        runnerArchiveFile: "actions-runner-win-x64.zip",
        interactiveUser: config.guest.sshUser,
        display: { width: 1080, height: 1920, scalePercent: 100 },
      });
      assert.equal(
        readFileSync(join(mediaRoot, SPICE_GUEST_TOOLS_INSTALLER_FILE), "utf8"),
        "spice-tools",
      );
      assert.equal(existsSync(join(mediaRoot, "prepare-vm-runtime.ps1")), true);
      assert.equal(
        readFileSync(join(mediaRoot, "actions-runner-win-x64.zip"), "utf8"),
        "runner-archive",
      );
      assert.match(
        bootstrapScript(),
        /-SpiceGuestToolsInstallerPath \(Join-Path \$mediaRoot \$config\.spiceGuestToolsInstallerFile\)/,
      );
      assert.match(
        bootstrapScript(),
        /shared-guest-preparation\.ps1"\) -WebView2InstallerUri[\s\S]*-AuthorizedKeysPath/,
      );
      assert.match(
        bootstrapScript(),
        /prepare-vm-runtime\.ps1"\) -Mode PrepareKvmGuest/,
      );
      assert.doesNotMatch(bootstrapScript(), /Win32_CDROMDrive/);
      assert.deepEqual(commands[0][0], "xorriso");
      assert.ok(commands[0][1].includes(mediaRoot));

      config.media.runnerArchiveSha256 = "b".repeat(64);
      await assert.rejects(
        createConfigurationMedia(config, join(root, "bad-hash-staging"), {
          runCommand: async () => {},
        }),
        /runnerArchivePath SHA-256 does not match/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps guest preparation separate from VM-only runner and toolchain setup", () => {
    const root = new URL(".", import.meta.url);
    const shared = readFileSync(
      new URL("./shared-guest-preparation.ps1", root),
      "utf8",
    );
    const runtime = readFileSync(
      new URL("./prepare-vm-runtime.ps1", root),
      "utf8",
    );
    const verify = readFileSync(
      new URL("./verify-vm-runtime.ps1", root),
      "utf8",
    );
    const builder = readFileSync(
      new URL("./build-win10-baseline.mjs", root),
      "utf8",
    );

    assert.match(shared, /WebView2/);
    assert.match(shared, /PlugPlay/);
    assert.match(shared, /W32Time/);
    assert.match(shared, /Stop-Service/);
    assert.match(shared, /OpenSSH\.Server/);
    assert.match(shared, /Direct physical SSH host preparation/);
    assert.doesNotMatch(
      shared,
      /SpiceGuestToolsInstallerPath|QXL|Restart-Computer|Set-ClientDisplayMode/,
    );
    assert.match(
      shared,
      /\[Parameter\(Mandatory = \$true\)\] \[string\] \$WebView2InstallerUri/,
    );
    assert.match(
      shared,
      /\[Parameter\(Mandatory = \$true\)\] \[string\] \$AuthorizedKeysPath/,
    );
    assert.doesNotMatch(shared, /SpiceGuestTools|QXL|actions-runner/i);
    assert.match(runtime, /PrepareKvmGuest/);
    assert.match(runtime, /SpiceGuestToolsInstallerPath/);
    assert.match(runtime, /New-ScheduledTaskPrincipal -UserId "SYSTEM"/);
    assert.match(runtime, /-Argument "\/S"/);
    assert.match(runtime, /exitCode -eq 3010/);
    assert.match(runtime, /exitCode -eq 1641/);
    assert.match(runtime, /QXL/);
    assert.match(runtime, /PrepareInteractiveDisplay/);
    assert.match(runtime, /RearmInteractiveDisplay/);
    assert.match(runtime, /GetInteractiveDisplayPreparationStatus/);
    assert.match(runtime, /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(
      runtime,
      /New-ScheduledTaskPrincipal[\s\S]*-LogonType Interactive/,
    );
    assert.match(runtime, /interactive-display-preparation\.json/);
    const spiceInstallFunction = runtime.slice(
      runtime.indexOf("function Install-SpiceGuestTools"),
      runtime.indexOf("function Disable-RemainingAutomaticLogon"),
    );
    assert.ok(
      spiceInstallFunction.indexOf('phase = "installing"') <
        spiceInstallFunction.indexOf("Invoke-SpiceGuestToolsInstallerAsSystem"),
      "the reboot resume state must be durable before the installer starts",
    );
    assert.ok(
      spiceInstallFunction.indexOf("Register-SpiceGuestToolsResume") <
        spiceInstallFunction.indexOf("Invoke-SpiceGuestToolsInstallerAsSystem"),
      "RunOnce must be registered before the installer can reboot Windows",
    );
    assert.match(
      spiceInstallFunction,
      /phase -eq "installing"[\s\S]*installBootIdentity -ne \$currentBootIdentity[\s\S]*Add-Member -NotePropertyName "resumeBootIdentity" -NotePropertyValue \$currentBootIdentity -Force/,
    );
    assert.doesNotMatch(
      spiceInstallFunction,
      /\.resumeBootIdentity\s*=/,
      "ConvertFrom-Json objects require Add-Member for a new resume field",
    );
    assert.match(
      spiceInstallFunction,
      /if \(\$exitCode -eq 0\)[\s\S]*Remove-SpiceGuestToolsResume/,
    );
    assert.ok(
      runtime.indexOf("Install-SpiceGuestTools") <
        runtime.indexOf("Set-ClientDisplayMode -Width"),
    );
    const prepareKvmGuest = runtime.slice(
      runtime.indexOf("function Prepare-KvmGuest"),
      runtime.indexOf('if ($Mode -eq "PrepareKvmGuest")'),
    );
    assert.match(prepareKvmGuest, /Initialize-InteractiveDisplayPreparation/);
    assert.doesNotMatch(
      prepareKvmGuest,
      /Set-ClientDisplayMode|Disable-RemainingAutomaticLogon/,
      "KVM preparation must not fake display state from the bootstrap or SSH session",
    );
    const prepareInteractiveDisplay = runtime.slice(
      runtime.indexOf("function Prepare-InteractiveDisplay"),
      runtime.indexOf("function Get-InteractiveDisplayPreparationStatus"),
    );
    assert.match(
      prepareInteractiveDisplay,
      /\[System\.Diagnostics\.Process\]::GetCurrentProcess\(\)\.SessionId/,
    );
    assert.match(
      prepareInteractiveDisplay,
      /WindowsIdentity]::GetCurrent\(\)\.Name/,
    );
    assert.match(prepareInteractiveDisplay, /Set-ClientDisplayMode -Width/);
    assert.match(
      runtime,
      /Move-Item -Force -LiteralPath \$temporaryPath -Destination \$Path/,
    );
    assert.match(
      prepareInteractiveDisplay,
      /Complete-InteractiveDisplayPreparation/,
    );
    assert.match(runtime, /Remove-InteractiveDisplayPreparationTask/);
    assert.match(runtime, /Disable-RemainingAutomaticLogon/);
    const rearmInteractiveDisplay = runtime.slice(
      runtime.indexOf("function Rearm-InteractiveDisplay"),
      runtime.indexOf("function Prepare-KvmGuest"),
    );
    assert.ok(
      rearmInteractiveDisplay.indexOf(
        "Initialize-InteractiveDisplayPreparation",
      ) < rearmInteractiveDisplay.indexOf("Restart-Computer -Force"),
      "the host-triggered retry must register the task before rebooting into autologon",
    );
    assert.match(runtime, /CDS_UPDATEREGISTRY/);
    assert.match(runtime, /interactive-display-report\.json/);
    assert.match(
      shared,
      /icacls\.exe" -ArgumentList @\(\$administratorsKeys, "\/inheritance:r", "\/grant", "\*S-1-5-32-544:F", "\/grant", "SYSTEM:F"\)/,
    );
    assert.doesNotMatch(shared, /"Administrators:F"/);
    assert.match(runtime, /Initialize-Disk/);
    assert.match(runtime, /FileSystemLabel/);
    assert.match(runtime, /SetEnvironmentVariable/);
    assert.match(runtime, /\$env:Path/);
    assert.match(runtime, /\.write-test/);
    assert.match(runtime, /C:\\actions-runner\\_work/);
    assert.match(runtime, /"--work", \$runnerWorkRoot/);
    assert.doesNotMatch(runtime, /D:\\runtime-cache\\actions-work/);
    assert.match(runtime, /\$nodeVersion = "24\.16\.0"/);
    assert.match(runtime, /\$pnpmVersion = "11\.9\.0"/);
    assert.match(runtime, /\$turboVersion = "2\.10\.0"/);
    assert.match(
      runtime,
      /\$rustToolchain = "1\.96\.0-x86_64-pc-windows-msvc"/,
    );
    assert.match(runtime, /\$nodeNamespace = "node-\$nodeVersion"/);
    assert.match(runtime, /\$pnpmNamespace = "pnpm-\$pnpmVersion"/);
    assert.match(runtime, /\$turboNamespace = "turbo-\$turboVersion"/);
    assert.match(runtime, /\$rustNamespace = "rust-1\.96\.0"/);
    assert.match(runtime, /pnpm-store\\\$pnpmNamespace/);
    assert.match(
      runtime,
      /CARGO_HOME = "\$toolchainRoot\\cargo\\\$rustNamespace"/,
    );
    assert.doesNotMatch(runtime, /CARGO_HOME = "\$cacheRoot/);
    assert.match(runtime, /cargo-registry\\\$rustNamespace/);
    assert.match(runtime, /New-Item -ItemType Junction/);
    assert.match(runtime, /turbo\\\$turboNamespace/);
    assert.match(
      runtime,
      /RUSTUP_HOME = "\$toolchainRoot\\rustup\\\$rustNamespace"/,
    );
    assert.doesNotMatch(runtime, /RUSTUP_HOME = "D:/);
    assert.match(runtime, /nodejs-lts", "--version=24\.16\.0"/);
    assert.match(
      runtime,
      /corepack\.cmd" -ArgumentList @\("prepare", "pnpm@11\.9\.0", "--activate"\)/,
    );
    assert.match(
      runtime,
      /pnpm\.cmd" -ArgumentList @\("add", "--global", "turbo@2\.10\.0"\)/,
    );
    assert.match(runtime, /pnpm version does not match \$pnpmVersion/);
    assert.match(runtime, /Turbo version does not match \$turboVersion/);
    assert.match(
      runtime,
      /rustup\.exe" -ArgumentList @\("toolchain", "install", "1\.96\.0-x86_64-pc-windows-msvc"/,
    );
    assert.doesNotMatch(
      runtime,
      /rustup\.exe" -ArgumentList @\("default", "stable"/,
    );
    assert.match(runtime, /RunnerArchivePath/);
    assert.doesNotMatch(
      runtime,
      /RunnerArchiveUri|Invoke-WebRequest -UseBasicParsing -Uri \$RunnerArchive/,
    );
    assert.doesNotMatch(shared, /config\.cmd|actions-runner|choco install/i);
    assert.match(runtime, /config\.cmd/);
    assert.match(runtime, /choco\.exe/);
    assert.ok(runtime.indexOf("choco.exe") < runtime.indexOf("config.cmd"));
    assert.match(runtime, /vswhere\.exe/);
    assert.match(runtime, /Microsoft\.VisualStudio\.Workload\.VCTools/);
    assert.match(runtime, /cl\.exe/);
    assert.match(runtime, /MFStartup/);
    assert.match(runtime, /FilterGraph/);
    assert.match(verify, /interactive-display-report\.json/);
    assert.match(verify, /SPICEGuestTools/);
    assert.match(verify, /QXL/);
    assert.match(verify, /rebootSemanticsValid/);
    assert.doesNotMatch(verify, /PrimaryScreen/);
    assert.match(verify, /ExpectedRunnerUrl/);
    assert.match(verify, /ExpectedRunnerName/);
    assert.match(verify, /ExpectedRunnerServiceName/);
    assert.match(verify, /ExpectedAudioModel/);
    assert.doesNotMatch(
      verify,
      /ExpectedAudioBackend|ExpectedAudioDeviceIdentity/,
    );
    assert.match(verify, /HDAUDIO\\\\/);
    assert.match(verify, /ExpectedSerialRole/);
    assert.match(verify, /ExpectedSerialUsbPort/);
    assert.doesNotMatch(verify, /ExpectedSerialDeviceIdentity/);
    assert.match(verify, /lower-controller and scanner USB port roles/);
    assert.doesNotMatch(verify, /serialPorts\.Count -ge 2/);
    assert.match(verify, /\$pnpmVersion = "11\.9\.0"/);
    assert.match(verify, /\$turboVersion = "2\.10\.0"/);
    assert.match(verify, /exactToolchainVersions/);
    assert.match(verify, /executablesOnSystemDisk/);
    assert.match(
      verify,
      /CARGO_HOME = "\$toolchainRoot\\cargo\\\$rustNamespace"/,
    );
    assert.match(builder, /UserKnownHostsFile=/);
    assert.match(builder, /<Group>Administrators<\/Group>/);
    assert.match(builder, /readJsonWithBom/);
    assert.match(builder, /domifaddr/);
    assert.match(builder, /qemu-img", \[\s*"convert"/);
    assert.match(builder, /publishVerifiedBaselineRelease/);
    assert.match(builder, /PrepareKvmGuest/);
    assert.match(builder, /ExpectedSerialUsbPort: \[1, 2\]/);
    assert.match(builder, /actions-runner-win-x64\.zip/);
    assert.doesNotMatch(builder, /RunnerArchiveUri/);
    assert.doesNotMatch(builder, /registrationToken:\s*secrets/);
    for (const expected of [
      "SSH",
      "WebView2",
      "Audio",
      "Serial",
      "1080",
      "1920",
    ]) {
      assert.match(verify, new RegExp(expected, "i"));
    }
    assert.match(verify, /AudioDeviceRole/);
    assert.match(verify, /cacheDisk/);
    assert.match(shared, /PreserveStartupType/);
    assert.match(
      shared,
      /Set-BaselineService -Name "Schedule" -PreserveStartupType/,
    );
    assert.doesNotMatch(shared, /Set-Service -Name "Schedule" -StartupType/);

    for (const script of [
      "shared-guest-preparation.ps1",
      "prepare-vm-runtime.ps1",
      "verify-vm-runtime.ps1",
    ]) {
      const parsed = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$null = [scriptblock]::Create([IO.File]::ReadAllText($env:BASELINE_PS_PARSE_PATH))",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BASELINE_PS_PARSE_PATH: new URL(`./${script}`, root).pathname,
          },
        },
      );
      if (parsed.error?.code === "ENOENT") continue;
      assert.equal(parsed.status, 0, `${script}: ${parsed.stderr}`);
    }
  });

  it("discovers a lease address for the fixed guest MAC rather than trusting a configured IP", () => {
    assert.equal(
      parseGuestAddress(
        " Name       MAC address          Protocol     Address\n" +
          "-------------------------------------------------------------------------------\n" +
          " vnet0      52:54:00:12:34:56    ipv4         192.0.2.44/24\n",
        "52:54:00:12:34:56",
      ),
      "192.0.2.44",
    );
    assert.equal(
      parseGuestAddress(
        "vnet0 52:54:00:aa:bb:cc ipv4 192.0.2.45/24",
        "52:54:00:12:34:56",
      ),
      null,
    );
  });

  it("parses a copied guest verification report with a UTF-8 BOM", () => {
    assert.deepEqual(
      readJsonWithBom('\ufeff{"ok":true,"checks":{"SSH":true}}'),
      { ok: true, checks: { SSH: true } },
    );
  });

  it("re-arms interactive display preparation after a SPICE reboot before starting the toolchain", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-interactive-display-rearm-"),
    );
    const config = buildConfig(stagingDirectory);
    const invocations = [];
    const interactiveReport = {
      schemaVersion: "win10-kvm-interactive-display/v1",
      interactiveUser: "KVM-BUILDER\\baseline",
      interactiveSessionId: 1,
      desktop: { width: 1080, height: 1920, scalePercent: 100 },
      qxlDisplayAdapter: "Red Hat QXL controller",
    };
    let rearmed = false;
    let now = 0;
    try {
      const verification = await waitForGuestVerification(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          initialRearmDelayMs: 0,
          now: () => now,
          pollIntervalMs: 1,
          runCommand: async (command, args) => {
            invocations.push({ command, args });
            const remoteCommand = args.at(-1) ?? "";
            if (command === "ssh" && remoteCommand === "exit") return {};
            if (
              command === "ssh" &&
              remoteCommand.includes("-EncodedCommand")
            ) {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              if (
                bound.parameters.Mode ===
                "GetInteractiveDisplayPreparationStatus"
              ) {
                return {
                  stdout: `${JSON.stringify(
                    rearmed
                      ? completedInteractiveDisplayStatus(
                          "boot-after-spice-restart",
                        )
                      : {
                          reportValid: false,
                          reportPresent: false,
                          state: { phase: "installing" },
                          task: null,
                          taskLogTail:
                            "SPICE reboot resumed before the display task",
                          currentBootIdentity: "boot-after-spice-restart",
                          spiceGuestToolsInstallation: {
                            phase: "installing",
                            installBootIdentity: "boot-before-spice-restart",
                          },
                        },
                  )}\n`,
                };
              }
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                rearmed = true;
                return {
                  stdout: `${JSON.stringify(
                    completedInteractiveDisplayStatus(
                      "boot-after-spice-restart",
                    ),
                  )}\n`,
                };
              }
            }
            if (command === "scp") {
              const source = args.at(-2) ?? "";
              const destination = args.at(-1);
              if (source.includes("interactive-display-report.json")) {
                writeFileSync(destination, JSON.stringify(interactiveReport));
              }
              if (source.includes("verification.json")) {
                writeFileSync(destination, JSON.stringify({ ok: true }));
              }
              return {};
            }
            if (command === config.runner.registrationTokenProvider.command) {
              return { stdout: "runner-token\n" };
            }
            return {};
          },
          sleep: async () => {
            now += 1;
          },
          timeoutMs: 20,
        },
      );

      assert.equal(verification.ok, true);
      const rearmIndex = invocations.findIndex(
        ({ command, args }) =>
          command === "ssh" &&
          (args.at(-1) ?? "").includes("-EncodedCommand") &&
          bindWindowsOpenSshPowerShellCommand(args.at(-1)).parameters.Mode ===
            "RearmInteractiveDisplay",
      );
      const interactiveReportIndex = invocations.findIndex(
        ({ command, args }) =>
          command === "scp" &&
          (args.at(-2) ?? "").includes("interactive-display-report.json"),
      );
      const toolchainIndex = invocations.findIndex(
        ({ command, args }) =>
          command === "ssh" &&
          (args.at(-1) ?? "").includes("prepare-toolchain.ps1"),
      );
      assert.ok(
        rearmIndex >= 0,
        "the missing report must trigger a bounded re-arm",
      );
      assert.ok(interactiveReportIndex > rearmIndex);
      assert.ok(
        toolchainIndex > interactiveReportIndex,
        "toolchain setup must not start until the interactive report is validated",
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("times out interactive display preparation with remote task diagnostics before toolchain setup", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-interactive-display-timeout-"),
    );
    const config = buildConfig(stagingDirectory);
    const invocations = [];
    let now = 0;
    try {
      await assert.rejects(
        waitForGuestVerification(
          config,
          "win10-runtime-baseline-build-test",
          stagingDirectory,
          {
            discoverGuestAddress: async () => "192.0.2.44",
            maxRearmAttempts: 0,
            now: () => now,
            pollIntervalMs: 1,
            runCommand: async (command, args) => {
              invocations.push({ command, args });
              const remoteCommand = args.at(-1) ?? "";
              if (command === "ssh" && remoteCommand === "exit") return {};
              if (command === "ssh" && remoteCommand !== "exit") {
                const bound =
                  bindWindowsOpenSshPowerShellCommand(remoteCommand);
                assert.equal(
                  bound.parameters.Mode,
                  "GetInteractiveDisplayPreparationStatus",
                );
                return {
                  stdout:
                    '{"reportValid":false,"reportPresent":false,"state":{"phase":"running"},"task":{"state":"Running","lastTaskResult":267009},"taskLogTail":"display task is still waiting for the QXL desktop"}\n',
                };
              }
              return {};
            },
            sleep: async () => {
              now += 1;
            },
            timeoutMs: 3,
          },
        ),
        /interactive display preparation timed out[\s\S]*report=absent[\s\S]*task state=Running[\s\S]*lastTaskResult=267009[\s\S]*display task is still waiting for the QXL desktop/,
      );
      assert.equal(
        invocations.some(
          ({ command, args }) =>
            command === "ssh" &&
            (args.at(-1) ?? "").includes("prepare-toolchain.ps1"),
        ),
        false,
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("binds Windows OpenSSH display commands through UTF-16LE Base64 without cmd quoting", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-encoded-display-command-"),
    );
    const config = buildConfig(stagingDirectory);
    config.guest.sshUser = "display user\\o'hara";
    const commands = [];
    try {
      const result = await waitForInteractiveDisplayReport(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          runCommand: async (command, args) => {
            if (command === "scp") {
              writeFileSync(
                args.at(-1),
                JSON.stringify(interactiveDisplayReport(config)),
              );
              return {};
            }
            const remoteCommand = args.at(-1);
            if (command === "ssh" && remoteCommand === "exit") return {};
            if (command === "ssh") {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              commands.push(bound);
              assert.equal(
                bound.parameters.InteractiveUser,
                "display user\\o'hara",
              );
              assert.equal(bound.parameters.DesktopWidth, 1080);
              assert.equal(bound.parameters.DesktopHeight, 1920);
              assert.equal(bound.parameters.DesktopScalePercent, 100);
              assert.equal(
                bound.parameters.Mode,
                "GetInteractiveDisplayPreparationStatus",
              );
              return {
                stdout: `${JSON.stringify(completedInteractiveDisplayStatus())}\n`,
              };
            }
            throw new Error(`unexpected command: ${command}`);
          },
        },
      );

      assert.equal(result.target, "display user\\o'hara@192.0.2.44");
      assert.equal(commands.length, 1);
      assert.match(
        commands[0].script,
        /-InteractiveUser \$request\.InteractiveUser/,
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("binds verifier ExpectedInteractiveUser through the encoded PowerShell request", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-encoded-verifier-command-"),
    );
    const config = buildConfig(stagingDirectory);
    config.guest.sshUser = "display user\\o'hara";
    let verifier = null;
    try {
      const report = await waitForGuestVerification(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          runCommand: async (command, args) => {
            const remoteCommand = args.at(-1) ?? "";
            if (command === "ssh" && remoteCommand === "exit") return {};
            if (
              command === "ssh" &&
              remoteCommand.includes("-EncodedCommand")
            ) {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              if (
                bound.parameters.Mode ===
                "GetInteractiveDisplayPreparationStatus"
              ) {
                return {
                  stdout: `${JSON.stringify(completedInteractiveDisplayStatus())}\n`,
                };
              }
              verifier = bound;
              return {};
            }
            if (command === "scp") {
              const source = args.at(-2) ?? "";
              if (source.includes("interactive-display-report.json")) {
                writeFileSync(
                  args.at(-1),
                  JSON.stringify(interactiveDisplayReport(config)),
                );
              }
              if (source.includes("verification.json")) {
                writeFileSync(args.at(-1), JSON.stringify({ ok: true }));
              }
              return {};
            }
            if (command === config.runner.registrationTokenProvider.command) {
              return { stdout: "runner-token\n" };
            }
            return {};
          },
        },
      );

      assert.equal(report.ok, true);
      assert.equal(
        verifier.parameters.ExpectedInteractiveUser,
        "display user\\o'hara",
      );
      assert.match(
        verifier.script,
        /-ExpectedInteractiveUser \$request\.ExpectedInteractiveUser/,
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("does not accept a valid display report until the guest published complete cleanup", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-cleanup-commit-"),
    );
    const config = buildConfig(stagingDirectory);
    const invocations = [];
    let statusPolls = 0;
    let now = 0;
    try {
      await waitForInteractiveDisplayReport(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          initialRearmDelayMs: 0,
          now: () => now,
          pollIntervalMs: 1,
          runCommand: async (command, args) => {
            const remoteCommand = args.at(-1) ?? "";
            invocations.push({ command, remoteCommand });
            if (command === "ssh" && remoteCommand === "exit") return {};
            if (command === "ssh") {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              if (
                bound.parameters.Mode ===
                "GetInteractiveDisplayPreparationStatus"
              ) {
                statusPolls += 1;
                return {
                  stdout: `${JSON.stringify(
                    statusPolls === 1
                      ? {
                          ...completedInteractiveDisplayStatus("boot-partial"),
                          state: { phase: "running" },
                          task: { state: "Running" },
                          cleanup: {
                            taskRemoved: false,
                            spiceGuestToolsResumeRemoved: false,
                            automaticLogonDisabled: false,
                          },
                        }
                      : completedInteractiveDisplayStatus("boot-final"),
                  )}\n`,
                };
              }
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                assert.equal(
                  bound.parameters.SpiceGuestToolsInstallerPath,
                  "C:\\ProgramData\\WindowsRuntimeBaseline\\media\\spice-guest-tools-0.141.exe",
                );
                return {
                  stdout: `${JSON.stringify({
                    action: "completed",
                    ...completedInteractiveDisplayStatus("boot-final"),
                  })}\n`,
                };
              }
            }
            if (command === "scp") {
              writeFileSync(
                args.at(-1),
                JSON.stringify(interactiveDisplayReport(config)),
              );
              return {};
            }
            throw new Error(`unexpected command: ${command}`);
          },
          sleep: async () => {
            now += 1;
          },
          displayStageTimeoutMs: 20,
          guestAvailabilityTimeoutMs: 20,
        },
      );

      const rearmIndex = invocations.findIndex(
        ({ command, remoteCommand }) =>
          command === "ssh" &&
          remoteCommand !== "exit" &&
          bindWindowsOpenSshPowerShellCommand(remoteCommand).parameters.Mode ===
            "RearmInteractiveDisplay",
      );
      const copyIndex = invocations.findIndex(
        ({ command }) => command === "scp",
      );
      assert.ok(rearmIndex >= 0);
      assert.ok(
        copyIndex > rearmIndex,
        "partial cleanup must be re-armed first",
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("requires every completed display status condition before accepting the report", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-completion-conditions-"),
    );
    const config = buildConfig(stagingDirectory);
    const incompleteStatuses = [
      {
        ...completedInteractiveDisplayStatus(),
        state: { phase: "running" },
      },
      {
        ...completedInteractiveDisplayStatus(),
        task: { state: "Ready" },
      },
      {
        ...completedInteractiveDisplayStatus(),
        cleanup: {
          taskRemoved: false,
          spiceGuestToolsResumeRemoved: true,
          automaticLogonDisabled: true,
        },
      },
      {
        ...completedInteractiveDisplayStatus(),
        cleanup: {
          taskRemoved: true,
          spiceGuestToolsResumeRemoved: false,
          automaticLogonDisabled: true,
        },
      },
      {
        ...completedInteractiveDisplayStatus(),
        cleanup: {
          taskRemoved: true,
          spiceGuestToolsResumeRemoved: true,
          automaticLogonDisabled: false,
        },
      },
    ];
    try {
      for (const incomplete of incompleteStatuses) {
        const invocations = [];
        let statusPolls = 0;
        let now = 0;
        await waitForInteractiveDisplayReport(
          config,
          "win10-runtime-baseline-build-test",
          stagingDirectory,
          {
            discoverGuestAddress: async () => "192.0.2.44",
            initialRearmDelayMs: 0,
            now: () => now,
            pollIntervalMs: 1,
            runCommand: async (command, args) => {
              const remoteCommand = args.at(-1) ?? "";
              invocations.push({ command, remoteCommand });
              if (command === "ssh" && remoteCommand === "exit") return {};
              if (command === "ssh") {
                const bound =
                  bindWindowsOpenSshPowerShellCommand(remoteCommand);
                if (
                  bound.parameters.Mode ===
                  "GetInteractiveDisplayPreparationStatus"
                ) {
                  statusPolls += 1;
                  return {
                    stdout: `${JSON.stringify(
                      statusPolls === 1
                        ? incomplete
                        : completedInteractiveDisplayStatus("boot-final"),
                    )}\n`,
                  };
                }
                if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                  return {
                    stdout: `${JSON.stringify(
                      completedInteractiveDisplayStatus("boot-final"),
                    )}\n`,
                  };
                }
              }
              if (command === "scp") {
                writeFileSync(
                  args.at(-1),
                  JSON.stringify(interactiveDisplayReport(config)),
                );
                return {};
              }
              throw new Error(`unexpected command: ${command}`);
            },
            sleep: async () => {
              now += 1;
            },
            displayStageTimeoutMs: 20,
            guestAvailabilityTimeoutMs: 20,
          },
        );
        const rearmIndex = invocations.findIndex(
          ({ command, remoteCommand }) =>
            command === "ssh" &&
            remoteCommand.includes("-EncodedCommand") &&
            bindWindowsOpenSshPowerShellCommand(remoteCommand).parameters
              .Mode === "RearmInteractiveDisplay",
        );
        const copyIndex = invocations.findIndex(
          ({ command }) => command === "scp",
        );
        assert.ok(rearmIndex >= 0);
        assert.ok(copyIndex > rearmIndex);
      }
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("waits for a reboot observation before accepting a post-rearm report or issuing another reboot", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-reboot-barrier-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    let sshProbes = 0;
    let rearmAttempts = 0;
    let statusPolls = 0;
    let copiedBootIdentity = null;
    try {
      await waitForInteractiveDisplayReport(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          initialRearmDelayMs: 0,
          maxRearmAttempts: 2,
          now: () => now,
          pollIntervalMs: 1,
          runCommand: async (command, args) => {
            const remoteCommand = args.at(-1) ?? "";
            if (command === "ssh" && remoteCommand === "exit") {
              sshProbes += 1;
              return sshProbes === 3 ? { failed: true } : {};
            }
            if (command === "ssh") {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                rearmAttempts += 1;
                return { failed: true };
              }
              if (
                bound.parameters.Mode ===
                "GetInteractiveDisplayPreparationStatus"
              ) {
                statusPolls += 1;
                return {
                  stdout: `${JSON.stringify(
                    statusPolls === 1
                      ? {
                          reportPresent: false,
                          reportValid: false,
                          state: { phase: "failed" },
                          task: null,
                          cleanup: {
                            taskRemoved: false,
                            spiceGuestToolsResumeRemoved: false,
                            automaticLogonDisabled: false,
                          },
                          currentBootIdentity: "boot-before-rearm",
                        }
                      : completedInteractiveDisplayStatus(
                          statusPolls === 2
                            ? "boot-before-rearm"
                            : "boot-after-rearm",
                        ),
                  )}\n`,
                };
              }
            }
            if (command === "scp") {
              copiedBootIdentity =
                statusPolls === 2 ? "boot-before-rearm" : "boot-after-rearm";
              writeFileSync(
                args.at(-1),
                JSON.stringify(interactiveDisplayReport(config)),
              );
              return {};
            }
            throw new Error(`unexpected command: ${command}`);
          },
          sleep: async () => {
            now += 1;
          },
          displayStageTimeoutMs: 20,
          guestAvailabilityTimeoutMs: 20,
        },
      );

      assert.equal(
        rearmAttempts,
        1,
        "must not issue an immediate second reboot",
      );
      assert.equal(copiedBootIdentity, "boot-after-rearm");
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("resets the re-arm delay after an observed guest reboot", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-rearm-delay-reset-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    let sshProbes = 0;
    let statusPolls = 0;
    const rearmTimes = [];
    try {
      await waitForInteractiveDisplayReport(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          initialRearmDelayMs: 3,
          maxRearmAttempts: 2,
          now: () => now,
          pollIntervalMs: 1,
          runCommand: async (command, args) => {
            const remoteCommand = args.at(-1) ?? "";
            if (command === "ssh" && remoteCommand === "exit") {
              sshProbes += 1;
              return sshProbes === 2 ? { failed: true } : {};
            }
            if (command === "ssh") {
              const bound = bindWindowsOpenSshPowerShellCommand(remoteCommand);
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                rearmTimes.push(now);
                return rearmTimes.length === 1
                  ? { failed: true }
                  : {
                      stdout: `${JSON.stringify({
                        action: "completed",
                        ...completedInteractiveDisplayStatus("boot-final"),
                      })}\n`,
                    };
              }
              if (
                bound.parameters.Mode ===
                "GetInteractiveDisplayPreparationStatus"
              ) {
                statusPolls += 1;
                if (statusPolls === 1) {
                  return {
                    stdout: `${JSON.stringify({
                      reportPresent: false,
                      reportValid: false,
                      state: { phase: "failed" },
                      task: null,
                      cleanup: {
                        taskRemoved: false,
                        spiceGuestToolsResumeRemoved: false,
                        automaticLogonDisabled: false,
                      },
                      currentBootIdentity: "boot-before-rearm",
                    })}\n`,
                  };
                }
                if (rearmTimes.length === 2) {
                  return {
                    stdout: `${JSON.stringify(completedInteractiveDisplayStatus("boot-final"))}\n`,
                  };
                }
                return {
                  stdout: `${JSON.stringify({
                    reportPresent: false,
                    reportValid: false,
                    state: { phase: "waiting-for-logon" },
                    task: null,
                    cleanup: {
                      taskRemoved: false,
                      spiceGuestToolsResumeRemoved: true,
                      automaticLogonDisabled: false,
                    },
                    currentBootIdentity: "boot-after-rearm",
                  })}\n`,
                };
              }
            }
            if (command === "scp") {
              writeFileSync(
                args.at(-1),
                JSON.stringify(interactiveDisplayReport(config)),
              );
              return {};
            }
            throw new Error(`unexpected command: ${command}`);
          },
          sleep: async () => {
            now += 1;
          },
          displayStageTimeoutMs: 30,
          guestAvailabilityTimeoutMs: 30,
        },
      );

      assert.equal(rearmTimes.length, 2);
      assert.ok(
        rearmTimes[1] - rearmTimes[0] >= 3,
        "the second re-arm must wait from the post-reboot SSH readiness",
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("starts the display-stage deadline only after SSH first becomes ready", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-deadline-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    try {
      await assert.rejects(
        waitForInteractiveDisplayReport(
          config,
          "win10-runtime-baseline-build-test",
          stagingDirectory,
          {
            discoverGuestAddress: async () => (now < 4 ? null : "192.0.2.44"),
            maxRearmAttempts: 0,
            now: () => now,
            pollIntervalMs: 1,
            runCommand: async (command, args) => {
              const remoteCommand = args.at(-1) ?? "";
              if (command === "ssh" && remoteCommand === "exit") return {};
              if (command === "ssh") {
                const bound =
                  bindWindowsOpenSshPowerShellCommand(remoteCommand);
                assert.equal(
                  bound.parameters.Mode,
                  "GetInteractiveDisplayPreparationStatus",
                );
                return {
                  stdout: `${JSON.stringify({
                    reportPresent: false,
                    reportValid: false,
                    state: { phase: "running" },
                    task: { state: "Running", lastTaskResult: 267009 },
                    cleanup: {
                      taskRemoved: false,
                      spiceGuestToolsResumeRemoved: false,
                      automaticLogonDisabled: false,
                    },
                    currentBootIdentity: "boot-display",
                  })}\n`,
                };
              }
              throw new Error(`unexpected command: ${command}`);
            },
            sleep: async () => {
              now += 1;
            },
            displayStageTimeoutMs: 2,
            guestAvailabilityTimeoutMs: 10,
          },
        ),
        /interactive display stage timed out after 2 ms[\s\S]*first SSH readiness at 4 ms/,
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("retains the 60-minute guest availability deadline before first SSH readiness", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-guest-availability-deadline-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    try {
      await assert.rejects(
        waitForInteractiveDisplayReport(
          config,
          "win10-runtime-baseline-build-test",
          stagingDirectory,
          {
            discoverGuestAddress: async () => null,
            now: () => now,
            pollIntervalMs: 1,
            sleep: async () => {
              now = 60 * 60 * 1000;
            },
          },
        ),
        /guest availability timed out after 3600000 ms[\s\S]*no discovered DHCP lease/,
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("cleans the exact construction domain and both staging paths when its process receives SIGTERM", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-construction-sigterm-"));
    const childPath = join(root, "construction-sigterm-child.mjs");
    const domainName = "win10-runtime-baseline-build-sigterm";
    const domainPath = join(root, domainName);
    const systemStagingPath = join(root, "system-staging");
    const cacheStagingPath = join(root, "cache-staging");
    const receiptPath = join(root, "cleanup-receipt.json");
    const readyPath = join(root, "ready");
    try {
      writeFileSync(childPath, constructionSignalCleanupChildSource());
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
            node "$1" "$2" "$3" "$4" "$5" "$6" "$7" &
            child="$!"
            for _ in $(seq 1 200); do
              test -f "$7" && break
              sleep 0.01
            done
            test -f "$7"
            kill -TERM "$child"
            wait "$child"
          `,
          "_",
          childPath,
          domainName,
          domainPath,
          systemStagingPath,
          cacheStagingPath,
          receiptPath,
          readyPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 143, result.stderr);
      assert.equal(existsSync(domainPath), false);
      assert.equal(existsSync(systemStagingPath), false);
      assert.equal(existsSync(cacheStagingPath), false);
      assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), {
        domainName,
        systemStagingPath,
        cacheStagingPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechecks guest completion after scheduling rearm and before a reboot", () => {
    const runtime = readFileSync(
      new URL("./prepare-vm-runtime.ps1", import.meta.url),
      "utf8",
    );
    const rearm = runtime.slice(
      runtime.indexOf("function Rearm-InteractiveDisplay"),
      runtime.indexOf("function Prepare-KvmGuest"),
    );
    const completionChecks = [
      ...rearm.matchAll(
        /Complete-InteractiveDisplayPreparationFromValidReport/g,
      ),
    ];
    assert.ok(completionChecks.length >= 2);
    assert.ok(
      completionChecks[1].index >
        rearm.indexOf("Initialize-InteractiveDisplayPreparation"),
    );
    assert.ok(
      completionChecks[1].index < rearm.indexOf("Restart-Computer -Force"),
    );
  });

  it("publishes the final display report only after cleanup and commits complete state last", () => {
    const runtime = readFileSync(
      new URL("./prepare-vm-runtime.ps1", import.meta.url),
      "utf8",
    );
    const completion = runtime.slice(
      runtime.indexOf("function Complete-InteractiveDisplayPreparation {"),
      runtime.indexOf(
        "function Complete-InteractiveDisplayPreparationFromValidReport",
      ),
    );
    assert.ok(
      completion.indexOf("Remove-InteractiveDisplayPreparationTask") <
        completion.indexOf(
          "Write-AtomicJson -Path $interactiveDisplayReportPath",
        ),
    );
    assert.ok(
      completion.indexOf("Remove-SpiceGuestToolsResume") <
        completion.indexOf(
          "Write-AtomicJson -Path $interactiveDisplayReportPath",
        ),
    );
    assert.ok(
      completion.indexOf("Disable-RemainingAutomaticLogon") <
        completion.indexOf(
          "Write-AtomicJson -Path $interactiveDisplayReportPath",
        ),
    );
    assert.ok(
      completion.indexOf(
        "Write-AtomicJson -Path $interactiveDisplayReportPath",
      ) <
        completion.indexOf(
          'Write-InteractiveDisplayPreparationState -Phase "complete"',
        ),
    );
    assert.match(runtime, /completionValid = \(Test-InteractiveDisplayReport/);
  });

  it("has an independent manual workflow that never uploads a baseline image", () => {
    const workflow = readFileSync(
      ".github/workflows/build-win10-kvm-baseline.yml",
      "utf8",
    );
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /concurrency:/);
    assert.match(workflow, /vem-windows-runtime-testbed/);
    assert.match(workflow, /cancel-in-progress: true/);
    assert.match(workflow, /default: vem-runtime/);
    assert.match(workflow, /build-win10-baseline\.mjs/);
    assert.doesNotMatch(
      workflow,
      /upload-artifact|scripts\/factory|build-factory-iso/i,
    );
  });

  it("uses the same latest-wins concurrency group and caller-owned host lock for baseline and acceptance", () => {
    const baselineWorkflow = readFileSync(
      ".github/workflows/build-win10-kvm-baseline.yml",
      "utf8",
    );
    const acceptanceWorkflow = readFileSync(
      ".github/workflows/vm-runtime-acceptance.yml",
      "utf8",
    );
    assert.match(baselineWorkflow, /group: vem-windows-runtime-testbed/);
    assert.match(acceptanceWorkflow, /group: vem-windows-runtime-testbed/);
    assert.match(acceptanceWorkflow, /VEM_VM_HOST_LOCK_PATH/);
    assert.match(acceptanceWorkflow, /Acquire Host Global Lock/);
    assert.match(acceptanceWorkflow, /Release Host Global Lock/);
    for (const workflow of [baselineWorkflow, acceptanceWorkflow]) {
      assert.match(workflow, /flock -n/);
      assert.doesNotMatch(workflow, /mkdir "\$VEM_VM_HOST_LOCK_PATH"/);
      assert.doesNotMatch(workflow, /rm -rf -- "\$VEM_VM_HOST_LOCK_PATH"/);
    }
    assert.match(acceptanceWorkflow, /trap "exit 0" TERM INT/);
    assert.match(acceptanceWorkflow, /kill -TERM "\$VEM_VM_HOST_LOCK_PID"/);
  });

  it("releases the host flock when the acceptance lock holder receives SIGTERM", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-flock-"));
    const lockPath = join(root, "vem-windows-runtime-testbed.lock");
    try {
      const cancelled = spawnSync(
        "bash",
        [
          "-c",
          `
            exec 9>"$1"
            flock -n 9
            trap "exit 0" TERM INT
            kill -TERM "$$"
            exit 1
          `,
          "_",
          lockPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(cancelled.status, 0, cancelled.stderr);
      assert.equal(spawnSync("flock", ["-n", lockPath, "true"]).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers only stale construction domains for this baseline before starting another build", async () => {
    const config = buildConfig("/var/tmp/vem-kvm-baseline-recovery");
    const invocations = [];
    const runCommand = async (command, args, options) => {
      invocations.push({ command, args, options });
      if (args.includes("list")) {
        return {
          stdout: [
            "win10-runtime-baseline-build-old-a",
            "win10-runtime-baseline-build-old-b",
            "win10-runtime-baseline-backup",
            "win10-runtime-baseline2-build-old",
            "other-build-old",
          ].join("\n"),
        };
      }
      return { stdout: "" };
    };

    await recoverStaleConstructionDomains(config, { runCommand });

    assert.deepEqual(invocations, [
      {
        command: "virsh",
        args: ["--connect", "qemu:///system", "list", "--all", "--name"],
        options: undefined,
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "destroy",
          "win10-runtime-baseline-build-old-a",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "undefine",
          "win10-runtime-baseline-build-old-a",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "destroy",
          "win10-runtime-baseline-build-old-b",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "undefine",
          "win10-runtime-baseline-build-old-b",
        ],
        options: { allowFailure: true },
      },
    ]);
  });

  it("keeps the new baseline boundary independent of historical image tooling", () => {
    for (const file of [
      "linux-kvm-baseline.mjs",
      "libvirt-runtime-profile.mjs",
      "build-win10-baseline.mjs",
    ]) {
      const source = readFileSync(
        new URL(`./${file}`, new URL(".", import.meta.url)),
        "utf8",
      );
      assert.doesNotMatch(
        source,
        /scripts\/factory|\.\.\/factory|Unraid|\/mnt\/user/i,
      );
    }
  });
});
