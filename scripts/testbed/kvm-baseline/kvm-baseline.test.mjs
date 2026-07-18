import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWin10Baseline,
  bootstrapScript,
  constructionCleanup,
  createConstructionCommandTracker,
  createConstructionWorkspace,
  createConfigurationMedia,
  guestConfigurationFor,
  recoverStaleConstructionDomains,
  renderUnattendedXml,
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
  REQUIRED_COMMANDS,
  baselinePublicationLayout,
  evaluateHostPreflight,
  parseGuestAddress,
  publishVerifiedBaselineRelease,
  readJsonWithBom,
  recoverPublishedBaseline,
  resolvePublishedBaselineRelease,
  runtimeProfileForConfig,
  runtimeProfileForPublishedRelease,
  startHeadlessVncActivator,
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
      registrationTokenProvider: {
        command: join(root, "bin", "issue-runner-token"),
        arguments: ["--repository", "example/runtime"],
      },
      name: "win10-runtime-baseline-runner",
      labels: ["vem-runtime"],
    },
    testbed: {
      reconstructCommand: [
        join(root, "bin", "reconstruct-runtime"),
        "--run-id",
        "{runId}",
      ],
      admitRunnerCommand: [
        join(root, "bin", "admit-runtime-runner"),
        "--run-id",
        "{runId}",
      ],
      guest: {
        host: "win10-runtime.example.test",
        user: "baseline",
        identityFile: join(root, "secrets", "administrator-private-key"),
        knownHostsFile: join(root, "ssh", "known_hosts"),
        stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        cacheRoot: "D:\\runtime-cache\\v1",
      },
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
    displayAdapter: "Microsoft Basic Display Adapter",
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

function trackedConstructionSignalCleanupChildSource() {
  return `
const baseline = await import(${JSON.stringify(new URL("./build-win10-baseline.mjs", import.meta.url).href)});
const {
  constructionCleanup,
  createConstructionCommandTracker,
  runWithConstructionSignalCleanup,
} = baseline;

const [domainName, systemStagingPath, cacheStagingPath, longChildPath, longChildPidPath, longChildReadyPath, lateDomainCreatorPath, lateDomainMarkerPath] = process.argv.slice(2);
const commandTracker = createConstructionCommandTracker();
const cleanup = constructionCleanup({
  cacheStagingDirectory: cacheStagingPath,
  config: { host: { libvirtUri: "qemu:///system" } },
  constructionDomain: domainName,
  runCommand: commandTracker.runCleanup,
  stagingDirectory: systemStagingPath,
});
await runWithConstructionSignalCleanup({
  abortInFlight: () => commandTracker.abortAndWait(),
  cleanup,
  exitOnSignal: true,
  work: async () => {
    try {
      await commandTracker.run(process.execPath, [
        longChildPath,
        longChildPidPath,
        longChildReadyPath,
      ]);
    } catch (error) {
      await commandTracker.run(process.execPath, [
        lateDomainCreatorPath,
        process.env.FAKE_DOMAIN_PATH,
        lateDomainMarkerPath,
      ]);
      throw error;
    }
  },
});
`;
}

function hardCrashActivatorChildSource() {
  return `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const builder = await import(${JSON.stringify(new URL("./build-win10-baseline.mjs", import.meta.url).href)});
const linux = await import(${JSON.stringify(new URL("./linux-kvm-baseline.mjs", import.meta.url).href)});
const [configPath, xvfbPath, windowManagerPath, viewerPath, readyPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const owner = await builder.createConstructionWorkspace(config, {
  nextBuildId: () => "deadbeef",
});
const tracker = builder.createConstructionCommandTracker({ terminationGraceMs: 100 });
const metadataPath = join(owner.systemStagingPath, linux.VNC_ACTIVATOR_METADATA_FILE);
await linux.startHeadlessVncActivator({
  domainName: owner.domainName,
  libvirtUri: config.host.libvirtUri,
  runCommand: async () => ({ stdout: ":19\\n", stderr: "" }),
  startProcess: tracker.start,
  commands: {
    xvfb: process.execPath,
    xvfbArguments: [xvfbPath],
    windowManager: process.execPath,
    windowManagerArguments: [windowManagerPath],
    viewer: process.execPath,
    viewerArguments: [viewerPath],
  },
  metadataPath,
  owner,
  readinessDelayMs: 20,
  termination: { termTimeoutMs: 100, killTimeoutMs: 500 },
});
await writeFile(readyPath, JSON.stringify({ metadataPath, owner }));
await new Promise(() => setInterval(() => {}, 1_000));
`;
}

function launchWindowCrashActivatorChildSource() {
  return `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const builder = await import(${JSON.stringify(new URL("./build-win10-baseline.mjs", import.meta.url).href)});
const linux = await import(${JSON.stringify(new URL("./linux-kvm-baseline.mjs", import.meta.url).href)});
const [configPath, xvfbPath, windowManagerPath, viewerPath, statePath, crashRole] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const owner = await builder.createConstructionWorkspace(config, {
  nextBuildId: () => "deadbeef",
});
const tracker = builder.createConstructionCommandTracker({ terminationGraceMs: 100 });
const metadataPath = join(owner.systemStagingPath, linux.VNC_ACTIVATOR_METADATA_FILE);
let launchIndex = 0;
const startProcess = (...arguments_) => {
  const handle = tracker.start(...arguments_);
  launchIndex += 1;
  const role = ["xvfb", "window-manager", "viewer"][launchIndex - 1];
  if (role === crashRole) {
    process.kill(handle.child.pid, "SIGSTOP");
    writeFileSync(statePath, JSON.stringify({ launchPid: handle.child.pid, metadataPath, owner, role }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return handle;
};
await linux.startHeadlessVncActivator({
  domainName: owner.domainName,
  libvirtUri: config.host.libvirtUri,
  runCommand: async () => ({ stdout: ":29\\n", stderr: "" }),
  startProcess,
  commands: {
    xvfb: process.execPath,
    xvfbArguments: [xvfbPath],
    windowManager: process.execPath,
    windowManagerArguments: [windowManagerPath],
    viewer: process.execPath,
    viewerArguments: [viewerPath],
  },
  environment: process.env,
  metadataPath,
  owner,
  readinessDelayMs: 20,
  termination: { termTimeoutMs: 100, killTimeoutMs: 500 },
});
writeFileSync(statePath, "unexpected completion");
`;
}

function assertProcessIsNotRunning(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingName = stat.lastIndexOf(")");
    assert.equal(stat.slice(closingName + 2).split(/\s+/, 1)[0], "Z");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function writePersistentFakeWindowManager(path) {
  writeFileSync(
    path,
    'process.on("SIGTERM", () => {}); await new Promise(() => setInterval(() => {}, 1_000));\n',
  );
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
      /<graphics type="vnc" autoport="yes" listen="127\.0\.0\.1"><listen type="address" address="127\.0\.0\.1"\/><\/graphics>/,
    );
    assert.match(
      xml,
      /<model type="virtio" vram="65536" heads="1" primary="yes"><resolution x="1080" y="1920"\/><\/model>/,
    );
    assert.doesNotMatch(xml, /<model type="(?:vga|bochs|qxl)"/);
    assert.match(xml, /target type="usb-serial" port="0"/);
    assert.match(xml, /<address type="usb" bus="0" port="1"\/>/);
    assert.match(xml, /<address type="usb" bus="0" port="2"\/>/);
    assert.match(
      xml,
      /<audio id="1" type="file"><output file="\/srv\/vm\/win10\.qcow2\.default-audio\.wav"\/><\/audio>/,
    );
    assert.match(xml, /<sound model="ich9"><audio id="1"\/><\/sound>/);
    assert.doesNotMatch(xml, /qxl|spice/i);
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

  it(
    "activates the dynamic loopback VNC display with tracked headless children and stops all",
    { timeout: 3_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-kvm-vnc-activator-"));
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-gvncviewer.mjs");
      const xvfbPidPath = join(root, "xvfb.pid");
      const viewerStatePath = join(root, "viewer.json");
      const metadataPath = join(root, ".vnc-activator.json");
      const owner = {
        schemaVersion: "win10-kvm-construction-owner/v1",
        buildId: "deadbeef",
        domainName: "win10-runtime-baseline-build-deadbeef",
        systemStagingPath: root,
      };
      let activator;
      try {
        writeFileSync(
          xvfbPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_XVFB_PID, String(process.pid));
process.stdout.write("73\\n");
process.on("SIGTERM", () => {});
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          viewerPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_VIEWER_STATE, JSON.stringify({
  pid: process.pid,
  endpoint: process.argv[2],
  display: process.env.DISPLAY,
}));
process.on("SIGTERM", () => {});
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writePersistentFakeWindowManager(windowManagerPath);
        const tracker = createConstructionCommandTracker();
        const commands = [];
        const startProcessWithStalledCompletion = (...arguments_) => {
          const handle = tracker.start(...arguments_);
          return { ...handle, completion: new Promise(() => {}) };
        };
        activator = await startHeadlessVncActivator({
          domainName: "win10-runtime-baseline-build-deadbeef",
          libvirtUri: "qemu:///system",
          runCommand: async (command, args) => {
            commands.push([command, args]);
            return { stdout: "127.0.0.1:9\n", stderr: "" };
          },
          startProcess: startProcessWithStalledCompletion,
          commands: {
            xvfb: process.execPath,
            xvfbArguments: [xvfbPath],
            windowManager: process.execPath,
            windowManagerArguments: [windowManagerPath],
            viewer: process.execPath,
            viewerArguments: [viewerPath],
          },
          environment: {
            ...process.env,
            FAKE_XVFB_PID: xvfbPidPath,
            FAKE_VIEWER_STATE: viewerStatePath,
          },
          metadataPath,
          owner,
          readinessDelayMs: 25,
          termination: { termTimeoutMs: 25, killTimeoutMs: 500 },
        });

        assert.deepEqual(commands, [
          [
            "virsh",
            [
              "--connect",
              "qemu:///system",
              "vncdisplay",
              "win10-runtime-baseline-build-deadbeef",
            ],
          ],
        ]);
        assert.equal(activator.endpoint, "127.0.0.1:9");
        assert.deepEqual(JSON.parse(readFileSync(viewerStatePath, "utf8")), {
          pid: JSON.parse(readFileSync(viewerStatePath, "utf8")).pid,
          endpoint: "127.0.0.1:9",
          display: ":73",
        });
        const xvfbPid = Number(readFileSync(xvfbPidPath, "utf8"));
        const viewerPid = JSON.parse(readFileSync(viewerStatePath, "utf8")).pid;
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        assert.equal(metadata.schemaVersion, "win10-kvm-vnc-activator/v3");
        assert.deepEqual(metadata.owner, owner);
        assert.deepEqual(Object.keys(metadata.processes), [
          "xvfb",
          "window-manager",
          "viewer",
        ]);
        assert.deepEqual(Object.keys(metadata.targets), [
          "xvfb",
          "window-manager",
          "viewer",
        ]);
        assert.notEqual(metadata.processes.xvfb.pid, xvfbPid);
        assert.notEqual(metadata.processes.viewer.pid, viewerPid);
        assert.equal(metadata.targets.xvfb.pid, xvfbPid);
        assert.equal(metadata.targets.viewer.pid, viewerPid);
        for (const identity of Object.values(metadata.processes)) {
          assert.match(identity.startTimeTicks, /^\d+$/);
          assert.match(identity.executable, /^\//);
          assert.match(identity.commandLineSha256, /^[0-9a-f]{64}$/);
          assert.doesNotThrow(() => process.kill(identity.pid, 0));
        }
        for (const identity of Object.values(metadata.targets)) {
          assert.match(identity.startTimeTicks, /^\d+$/);
          assert.match(identity.executable, /^\//);
          assert.match(identity.commandLineSha256, /^[0-9a-f]{64}$/);
          assert.doesNotThrow(() => process.kill(identity.pid, 0));
        }
        const stopStartedAt = Date.now();
        await activator.stop();
        assert.ok(Date.now() - stopStartedAt < 1_000);
        assert.equal(existsSync(metadataPath), false);
        for (const identity of Object.values(metadata.processes)) {
          assertProcessIsNotRunning(identity.pid);
        }
        assert.throws(() => process.kill(xvfbPid, 0), /ESRCH/);
        assert.throws(() => process.kill(viewerPid, 0), /ESRCH/);
      } finally {
        await activator?.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "waits for each VNC target identity to persist before starting the next role",
    { timeout: 5_000 },
    async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const root = mkdtempSync(
          join(tmpdir(), `vem-kvm-vnc-target-barrier-${attempt}-`),
        );
        const xvfbPath = join(root, "fake-xvfb.mjs");
        const gatekeeperPath = join(root, "fake-gatekeeper.mjs");
        const windowManagerStatePath = join(root, "window-manager.json");
        const viewerStatePath = join(root, "viewer.json");
        const metadataPath = join(root, ".vnc-activator.json");
        const owner = {
          schemaVersion: "win10-kvm-construction-owner/v1",
          buildId: "facefeed",
          domainName: "win10-runtime-baseline-build-facefeed",
          systemStagingPath: root,
        };
        let activator;
        try {
          writeFileSync(
            xvfbPath,
            'process.stdout.write("76\\n"); process.on("SIGTERM", () => {}); await new Promise(() => setInterval(() => {}, 1_000));\n',
          );
          writeFileSync(
            gatekeeperPath,
            `
import { readFileSync, writeFileSync } from "node:fs";

const [role, requiredTargetRole, statePath] = process.argv.slice(2);
const metadata = JSON.parse(readFileSync(process.env.FAKE_METADATA_PATH, "utf8"));
if (!metadata.targets?.[requiredTargetRole]) {
  process.exit(42);
}
writeFileSync(
  statePath,
  JSON.stringify({
    role,
    requiredTargetRole,
    observedTargets: Object.keys(metadata.targets).sort(),
  }),
);
process.on("SIGTERM", () => {});
await new Promise(() => setInterval(() => {}, 1_000));
`,
          );
          const tracker = createConstructionCommandTracker();
          activator = await startHeadlessVncActivator({
            domainName: owner.domainName,
            libvirtUri: "qemu:///system",
            runCommand: async () => ({ stdout: ":14\n", stderr: "" }),
            startProcess: tracker.start,
            commands: {
              xvfb: process.execPath,
              xvfbArguments: [xvfbPath],
              windowManager: process.execPath,
              windowManagerArguments: [
                gatekeeperPath,
                "window-manager",
                "xvfb",
                windowManagerStatePath,
              ],
              viewer: process.execPath,
              viewerArguments: [
                gatekeeperPath,
                "viewer",
                "window-manager",
                viewerStatePath,
              ],
            },
            environment: {
              ...process.env,
              FAKE_METADATA_PATH: metadataPath,
              VEM_VNC_SUPERVISOR_TARGET_REGISTRATION_DELAY_MS: "100",
            },
            metadataPath,
            owner,
            readinessDelayMs: 25,
            termination: { termTimeoutMs: 25, killTimeoutMs: 500 },
          });

          assert.deepEqual(
            JSON.parse(readFileSync(windowManagerStatePath, "utf8")),
            {
              role: "window-manager",
              requiredTargetRole: "xvfb",
              observedTargets: ["xvfb"],
            },
          );
          assert.deepEqual(JSON.parse(readFileSync(viewerStatePath, "utf8")), {
            role: "viewer",
            requiredTargetRole: "window-manager",
            observedTargets: ["window-manager", "xvfb"],
          });
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
          assert.ok(metadata.targets.xvfb);
          assert.ok(metadata.targets["window-manager"]);
          assert.ok(metadata.targets.viewer);
        } finally {
          await activator?.stop();
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "aborts and awaits all tracked VNC activator children",
    { timeout: 3_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-kvm-vnc-cancel-"));
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-gvncviewer.mjs");
      const xvfbPidPath = join(root, "xvfb.pid");
      const viewerStatePath = join(root, "viewer.json");
      const metadataPath = join(root, ".vnc-activator.json");
      const owner = {
        schemaVersion: "win10-kvm-construction-owner/v1",
        buildId: "cafebabe",
        domainName: "win10-runtime-baseline-build-cafebabe",
        systemStagingPath: root,
      };
      try {
        writeFileSync(
          xvfbPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_XVFB_PID, String(process.pid));
process.stdout.write("74\\n");
process.on("SIGTERM", () => {});
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          viewerPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_VIEWER_STATE, JSON.stringify({ pid: process.pid }));
process.on("SIGTERM", () => {});
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writePersistentFakeWindowManager(windowManagerPath);
        const tracker = createConstructionCommandTracker({
          terminationGraceMs: 25,
        });
        const activator = await startHeadlessVncActivator({
          domainName: "win10-runtime-baseline-build-cafebabe",
          libvirtUri: "qemu:///system",
          runCommand: async () => ({ stdout: ":12\n", stderr: "" }),
          startProcess: tracker.start,
          commands: {
            xvfb: process.execPath,
            xvfbArguments: [xvfbPath],
            windowManager: process.execPath,
            windowManagerArguments: [windowManagerPath],
            viewer: process.execPath,
            viewerArguments: [viewerPath],
          },
          environment: {
            ...process.env,
            FAKE_XVFB_PID: xvfbPidPath,
            FAKE_VIEWER_STATE: viewerStatePath,
          },
          metadataPath,
          owner,
          readinessDelayMs: 25,
          termination: { termTimeoutMs: 25, killTimeoutMs: 500 },
        });
        const xvfbPid = Number(readFileSync(xvfbPidPath, "utf8"));
        const viewerPid = JSON.parse(readFileSync(viewerStatePath, "utf8")).pid;

        await tracker.abortAndWait();
        await activator.stop();
        assert.throws(() => process.kill(xvfbPid, 0), /ESRCH/);
        assert.throws(() => process.kill(viewerPid, 0), /ESRCH/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "fails active construction promptly when a VNC activator child exits later",
    { timeout: 3_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-kvm-vnc-late-exit-"));
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-gvncviewer.mjs");
      const metadataPath = join(root, ".vnc-activator.json");
      const owner = {
        schemaVersion: "win10-kvm-construction-owner/v1",
        buildId: "0123abcd",
        domainName: "win10-runtime-baseline-build-0123abcd",
        systemStagingPath: root,
      };
      let activator;
      try {
        writeFileSync(
          xvfbPath,
          'process.stdout.write("75\\n"); await new Promise(() => setInterval(() => {}, 1_000));\n',
        );
        writeFileSync(
          viewerPath,
          "await new Promise((resolve) => setTimeout(resolve, 75));\n",
        );
        writePersistentFakeWindowManager(windowManagerPath);
        const tracker = createConstructionCommandTracker();
        const startProcessWithStalledCompletion = (...arguments_) => {
          const handle = tracker.start(...arguments_);
          if (
            arguments_[0] !== process.execPath ||
            arguments_[1][0] !== viewerPath
          ) {
            return handle;
          }
          return { ...handle, completion: new Promise(() => {}) };
        };
        activator = await startHeadlessVncActivator({
          domainName: owner.domainName,
          libvirtUri: "qemu:///system",
          runCommand: async () => ({ stdout: ":13\n", stderr: "" }),
          startProcess: startProcessWithStalledCompletion,
          commands: {
            xvfb: process.execPath,
            xvfbArguments: [xvfbPath],
            windowManager: process.execPath,
            windowManagerArguments: [windowManagerPath],
            viewer: process.execPath,
            viewerArguments: [viewerPath],
          },
          metadataPath,
          owner,
          readinessDelayMs: 20,
        });

        await assert.rejects(
          activator.runWhileActive(() => new Promise(() => {})),
          /gvncviewer exited during VNC activation/,
        );
      } finally {
        await activator?.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("verifies the defined ICH9 audio device and exact USB-port serial role mapping", () => {
    const profile = createRuntimeProfile({
      vmName: "win10-runtime-baseline",
      systemDiskPath: "/srv/vm/win10.qcow2",
      cacheDiskPath: "/srv/vm/win10-cache.qcow2",
      networkName: "runtime-testbed",
      macAddress: "52:54:00:12:34:56",
    });
    const xml = renderLibvirtDomainXml(profile);

    assert.deepEqual(verifyDefinedRuntimeDevices(xml, profile), {
      audio: {
        model: "ich9",
        defaultDevice: true,
        capturePath: "/srv/vm/win10.qcow2.default-audio.wav",
      },
      serialRoles: ["lower-controller", "scanner"],
      serialUsbPorts: [1, 2],
    });
    assert.throws(
      () =>
        verifyDefinedRuntimeDevices(
          xml.replace('sound model="ich9"', 'sound model="ac97"'),
          profile,
        ),
      /default ICH9 audio device/,
    );
    assert.throws(
      () =>
        verifyDefinedRuntimeDevices(
          xml.replace(
            "</devices>",
            '<audio id="2" type="file"><output file="/tmp/injected.wav"/></audio></devices>',
          ),
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
    const configured = buildConfig("/var/tmp/vem-kvm-audio-profile");
    configured.storage.audioCapturePath = "/tmp/injected.wav";
    assert.equal(
      runtimeProfileForConfig(configured).audio.capturePath,
      `${configured.storage.baselinePath}.default-audio.wav`,
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

  it("requires caller-owned identity, storage, media, network, runner, and testbed inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-config-"));
    try {
      const config = buildConfig(root);
      assert.deepEqual(validateBaselineBuildConfig(config), config);

      delete config.runner.registrationTokenProvider;
      assert.throws(
        () => validateBaselineBuildConfig(config),
        /runner\.registrationTokenProvider/,
      );

      const missingRunnerLabels = buildConfig(root);
      delete missingRunnerLabels.runner.labels;
      assert.throws(
        () => validateBaselineBuildConfig(missingRunnerLabels),
        /runner\.labels/,
      );

      const runnerLabelsWithoutRuntime = buildConfig(root);
      runnerLabelsWithoutRuntime.runner.labels = ["custom"];
      assert.throws(
        () => validateBaselineBuildConfig(runnerLabelsWithoutRuntime),
        /runner\.labels must include the vem-runtime label/,
      );

      const missingRunnerArchive = buildConfig(root);
      delete missingRunnerArchive.media.runnerArchivePath;
      assert.throws(
        () => validateBaselineBuildConfig(missingRunnerArchive),
        /media\.runnerArchivePath/,
      );

      const missingVirtioWinIso = buildConfig(root);
      delete missingVirtioWinIso.media.virtioWinIsoPath;
      assert.throws(
        () => validateBaselineBuildConfig(missingVirtioWinIso),
        /media\.virtioWinIsoPath/,
      );

      const externalVirtioWinIso = buildConfig(root);
      externalVirtioWinIso.media.virtioWinIsoPath = "/outside/virtio-win.iso";
      assert.throws(
        () => validateBaselineBuildConfig(externalVirtioWinIso),
        /media\.virtioWinIsoPath must stay under host\.largeFileRoot/,
      );

      const invalidRunnerArchiveHash = buildConfig(root);
      invalidRunnerArchiveHash.media.runnerArchiveSha256 = "not-a-sha256";
      assert.throws(
        () => validateBaselineBuildConfig(invalidRunnerArchiveHash),
        /media\.runnerArchiveSha256/,
      );

      const missingTestbed = buildConfig(root);
      delete missingTestbed.testbed;
      assert.throws(
        () => validateBaselineBuildConfig(missingTestbed),
        /testbed must be an object/,
      );

      const relativeTestbedIdentity = buildConfig(root);
      relativeTestbedIdentity.testbed.guest.identityFile = "guest-key";
      assert.throws(
        () => validateBaselineBuildConfig(relativeTestbedIdentity),
        /testbed\.guest\.identityFile must be a canonical absolute Unix path/,
      );

      const invalidReconstructCommand = buildConfig(root);
      invalidReconstructCommand.testbed.reconstructCommand = [""];
      assert.throws(
        () => validateBaselineBuildConfig(invalidReconstructCommand),
        /testbed\.reconstructCommand must be a non-empty command array/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes the Issue15 testbed binding in the existing current manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-testbed-binding-"));
    try {
      const config = buildConfig(root);
      await publishRelease(config, "release-testbed-binding", "binding");
      const current = JSON.parse(
        readFileSync(
          baselinePublicationLayout(config).currentManifestPath,
          "utf8",
        ),
      );

      assert.equal(current.schemaVersion, "win10-kvm-baseline-current/v1");
      assert.deepEqual(current.testbed, config.testbed);
      assert.equal(
        current.profile.disks.system.path,
        current.artifacts.systemPath,
      );
      assert.equal(
        current.profile.disks.cache.path,
        current.artifacts.cachePath,
      );
      assert.deepEqual(current.profile.display, {
        width: 1080,
        height: 1920,
        scalePercent: 100,
        videoMemoryKiB: 65_536,
      });
      assert.equal(
        current.artifacts.domainXmlPath.endsWith("/runtime-profile.xml"),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has no SPICE or QXL installer contract, media, state, or cleanup plumbing", () => {
    const config = buildConfig("/var/tmp/vem-kvm-no-spice-contract");
    assert.doesNotThrow(() => validateBaselineBuildConfig(config));
    assert.deepEqual(guestConfigurationFor(config), {
      webView2InstallerUri: config.media.webView2InstallerUri,
      runnerArchiveFile: "actions-runner-win-x64.zip",
      virtioGpuDriverDirectory: "virtio-gpu-driver",
      virtioGpuDriverIdentityFile: "virtio-gpu-driver-identity.json",
      interactiveUser: config.guest.sshUser,
      display: { width: 1080, height: 1920, scalePercent: 100 },
    });
    for (const file of [
      "build-win10-baseline.mjs",
      "linux-kvm-baseline.mjs",
      "prepare-vm-runtime.ps1",
      "verify-vm-runtime.ps1",
      "libvirt-runtime-profile.mjs",
    ]) {
      assert.doesNotMatch(
        readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
        /spice|qxl/i,
        `${file} retains retired SPICE/QXL plumbing`,
      );
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
              "Xvfb",
              "openbox",
              "gvncviewer",
              "setpriv",
              "socat",
            ],
            cpuCount: 32,
            availableMemoryMiB: 64 * 1024,
            availableStorageBytes: 200 * 1024 ** 3,
            installationMedia: {
              windowsIso: true,
              virtioWinIso: true,
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
              "Xvfb",
              "openbox",
              "gvncviewer",
              "setpriv",
              "socat",
            ],
            cpuCount: 8,
            availableMemoryMiB: 16 * 1024,
            availableStorageBytes: 79 * 1024 ** 3,
            installationMedia: {
              windowsIso: true,
              virtioWinIso: true,
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
      const validObservation = {
        hostIdentity: hostIdentity(),
        kvmAvailable: true,
        libvirtAvailable: true,
        commands: [...REQUIRED_COMMANDS],
        cpuCount: 8,
        availableMemoryMiB: 16 * 1024,
        installationMedia: {
          windowsIso: true,
          virtioWinIso: true,
          runnerArchive: true,
        },
        networkActive: true,
        storageAvailableBytes: {
          baseline: 80 * 1024 ** 3,
          cache: 80 * 1024 ** 3,
        },
      };
      assert.deepEqual(evaluateHostPreflight(config, validObservation), {
        ok: true,
      });
      assert.throws(
        () =>
          evaluateHostPreflight(config, {
            ...validObservation,
            installationMedia: {
              ...validObservation.installationMedia,
              virtioWinIso: false,
            },
          }),
        /VirtIO Windows driver media must be a readable regular file/,
      );
      assert.throws(
        () =>
          evaluateHostPreflight(config, {
            ...validObservation,
            commands: validObservation.commands.filter(
              (command) => command !== "gvncviewer",
            ),
          }),
        /missing host tools: gvncviewer/,
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
              "Xvfb",
              "openbox",
              "gvncviewer",
              "setpriv",
            ],
            cpuCount: 8,
            availableMemoryMiB: 16 * 1024,
            installationMedia: {
              windowsIso: true,
              virtioWinIso: true,
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

  it("preserves a recoverable current pointer when directory fsync fails after manifest rename", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-baseline-current-fsync-failure-"),
    );
    try {
      const config = buildConfig(root);
      const oldRelease = await publishRelease(
        config,
        "release-old-current-fsync",
        "old",
      );
      const staged = stagedRelease(config, "current-fsync", "new");
      const layout = baselinePublicationLayout(config);
      const operations = [];

      await assert.rejects(
        publishVerifiedBaselineRelease({
          config,
          releaseId: "release-new-current-fsync",
          stagedSystemPath: staged.system,
          stagedCachePath: staged.cache,
          stagedDomainXmlPath: staged.domainXml,
          stagedDiagnosticPath: staged.diagnostic,
          profile: runtimeProfileForPublishedRelease(
            config,
            "release-new-current-fsync",
          ),
          verified: true,
          commitDefinition: async (release) => {
            operations.push(`define:${release.releaseId}`);
          },
          rollbackDefinition: async (release) => {
            operations.push(`restore:${release.releaseId}`);
          },
          syncCurrentManifestDirectory: async () => {
            const error = new Error("simulated current manifest fsync failure");
            error.code = "EIO";
            throw error;
          },
        }),
        /simulated current manifest fsync failure/,
      );

      assert.deepEqual(operations, ["define:release-new-current-fsync"]);
      assert.equal(
        JSON.parse(readFileSync(layout.currentManifestPath, "utf8")).releaseId,
        "release-new-current-fsync",
      );
      assert.equal(
        existsSync(join(layout.systemReleaseRoot, "release-new-current-fsync")),
        true,
      );
      assert.equal(
        existsSync(join(layout.cacheReleaseRoot, "release-new-current-fsync")),
        true,
      );
      assert.equal(existsSync(layout.publicationJournalPath), true);
      assert.equal(existsSync(layout.previousReleasePath), true);

      const recoveredDefinitions = [];
      const recovered = await recoverPublishedBaseline(config, {
        recoverDefinition: async (release) => {
          recoveredDefinitions.push(release.releaseId);
        },
        rollbackDefinition: async () => {},
      });
      assert.equal(recovered.releaseId, "release-new-current-fsync");
      assert.deepEqual(recoveredDefinitions, ["release-new-current-fsync"]);
      assert.equal(
        existsSync(join(layout.systemReleaseRoot, oldRelease.releaseId)),
        false,
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

  it("extracts only the signed Win10 amd64 VirtIO GPU driver payload into configuration media", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-config-media-"));
    try {
      const config = buildConfig(root);
      mkdirSync(dirname(config.guest.administratorPasswordFile), {
        recursive: true,
      });
      mkdirSync(dirname(config.media.runnerArchivePath), { recursive: true });
      writeFileSync(config.guest.administratorPasswordFile, "test-password\n");
      writeFileSync(config.guest.authorizedKeysFile, "ssh-ed25519 test\n");
      writeFileSync(config.media.runnerArchivePath, "runner-archive");
      config.media.runnerArchiveSha256 = createHash("sha256")
        .update("runner-archive")
        .digest("hex");
      const commands = [];
      const stagingDirectory = join(root, "staging");
      const configurationMedia = await createConfigurationMedia(
        config,
        stagingDirectory,
        {
          runCommand: async (...command) => {
            commands.push(command);
            const [program, args] = command;
            if (program === "xorriso" && args.includes("-extract")) {
              const destination = args.at(-1);
              mkdirSync(destination, { recursive: true });
              writeFileSync(join(destination, "viogpudo.inf"), "signed inf");
              writeFileSync(join(destination, "viogpudo.cat"), "catalog");
              writeFileSync(join(destination, "viogpudo.sys"), "driver");
            }
          },
        },
      );

      const mediaRoot = join(stagingDirectory, "configuration-media");
      assert.deepEqual(guestConfigurationFor(config), {
        webView2InstallerUri: config.media.webView2InstallerUri,
        runnerArchiveFile: "actions-runner-win-x64.zip",
        virtioGpuDriverDirectory: "virtio-gpu-driver",
        virtioGpuDriverIdentityFile: "virtio-gpu-driver-identity.json",
        interactiveUser: config.guest.sshUser,
        display: { width: 1080, height: 1920, scalePercent: 100 },
      });
      assert.equal(existsSync(join(mediaRoot, "prepare-vm-runtime.ps1")), true);
      assert.equal(
        readFileSync(join(mediaRoot, "actions-runner-win-x64.zip"), "utf8"),
        "runner-archive",
      );
      assert.deepEqual(
        readdirSync(join(mediaRoot, "virtio-gpu-driver")).sort(),
        ["viogpudo.cat", "viogpudo.inf", "viogpudo.sys"],
      );
      const driverIdentity = JSON.parse(
        readFileSync(
          join(mediaRoot, "virtio-gpu-driver-identity.json"),
          "utf8",
        ),
      );
      assert.deepEqual(
        configurationMedia.virtioGpuDriverIdentity,
        driverIdentity,
      );
      assert.equal(
        driverIdentity.schemaVersion,
        "win10-kvm-virtio-gpu-driver-package/v2",
      );
      assert.match(driverIdentity.packageSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(driverIdentity.driverStoreFiles, driverIdentity.files);
      assert.match(
        bootstrapScript(),
        /prepare-vm-runtime\.ps1"\) -Mode PrepareKvmGuest -VirtioGpuDriverPath \(Join-Path \$mediaRoot \$config\.virtioGpuDriverDirectory\) -VirtioGpuDriverIdentityPath \(Join-Path \$mediaRoot \$config\.virtioGpuDriverIdentityFile\)/,
      );
      assert.doesNotMatch(bootstrapScript(), /SpiceGuestToolsInstallerPath/);
      assert.match(
        bootstrapScript(),
        /shared-guest-preparation\.ps1"\) -WebView2InstallerUri[\s\S]*-AuthorizedKeysPath/,
      );
      assert.match(
        bootstrapScript(),
        /prepare-vm-runtime\.ps1"\) -Mode PrepareKvmGuest/,
      );
      assert.match(bootstrapScript(), /win10-kvm-bootstrap-failure\/v1/);
      assert.match(bootstrapScript(), /bootstrap-failure\.json/);
      assert.doesNotMatch(bootstrapScript(), /Win32_CDROMDrive/);
      assert.deepEqual(commands[0], [
        "xorriso",
        [
          "-osirrox",
          "on",
          "-indev",
          config.media.virtioWinIsoPath,
          "-extract",
          "/viogpudo/w10/amd64",
          join(mediaRoot, "virtio-gpu-driver"),
        ],
      ]);
      assert.deepEqual(commands[1][0], "xorriso");
      assert.ok(commands[1][1].includes(mediaRoot));

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

  it("distinguishes signed viogpudo releases with the same INF basename by package content", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-viogpudo-identity-"));
    const first = join(root, "first");
    const second = join(root, "second");
    try {
      for (const directory of [first, second]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "viogpudo.inf"), "same inf name");
        writeFileSync(join(directory, "viogpudo.cat"), "signed catalog");
        writeFileSync(join(directory, "viogpudo.pdb"), "distribution symbols");
      }
      writeFileSync(join(first, "viogpudo.sys"), "release one");
      writeFileSync(join(second, "viogpudo.sys"), "release two");
      const { createVirtioGpuDriverPackageIdentity } =
        await import("./build-win10-baseline.mjs");

      const firstIdentity = await createVirtioGpuDriverPackageIdentity(first);
      const secondIdentity = await createVirtioGpuDriverPackageIdentity(second);
      assert.deepEqual(
        firstIdentity.files.map(({ path }) => path),
        secondIdentity.files.map(({ path }) => path),
      );
      assert.notEqual(
        firstIdentity.packageSha256,
        secondIdentity.packageSha256,
      );
      assert.match(firstIdentity.packageSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(
        firstIdentity.driverStoreFiles.map(({ path }) => path),
        ["viogpudo.cat", "viogpudo.inf", "viogpudo.sys"],
      );
      assert.equal(
        firstIdentity.driverStoreFiles.some(({ path }) =>
          path.endsWith(".pdb"),
        ),
        false,
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
    assert.match(shared, /\$ProgressPreference = "SilentlyContinue"/);
    assert.match(shared, /for \(\$attempt = 1; \$attempt -le 3;/);
    assert.match(shared, /did not reach Installed state/);
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
    assert.match(runtime, /System\.IO\.Compression\.ZipFile/);
    assert.doesNotMatch(runtime, /Expand-Archive/);
    assert.match(runtime, /Set-Disk -Number \$disk\.Number -IsOffline \$false/);
    assert.match(runtime, /Set-Disk -Number \$disk\.Number -IsReadOnly \$false/);
    assert.doesNotMatch(runtime, /-IsOffline \$false -IsReadOnly \$false/);
    assert.match(runtime, /PrepareInteractiveDisplay/);
    assert.match(runtime, /RearmInteractiveDisplay/);
    assert.match(runtime, /GetInteractiveDisplayPreparationStatus/);
    assert.match(runtime, /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(
      runtime,
      /New-ScheduledTaskPrincipal[\s\S]*-LogonType Interactive/,
    );
    assert.match(runtime, /interactive-display-preparation\.json/);
    const prepareKvmGuest = runtime.slice(
      runtime.indexOf("function Prepare-KvmGuest"),
      runtime.indexOf('if ($Mode -eq "PrepareKvmGuest")'),
    );
    assert.match(
      runtime,
      /function Install-VirtioGpuDisplayDriver[\s\S]*pnputil\.exe[\s\S]*@\("\/add-driver", \$driverInf\.FullName, "\/install"\)/,
    );
    assert.match(runtime, /\$driverInstallExitCode -notin @\(0, 259, 3010\)/);
    assert.match(
      runtime,
      /function Test-VirtioGpuDriverBinding[\s\S]*Win32_VideoController[\s\S]*Win32_PnPSignedDriver/,
    );
    assert.match(
      runtime,
      /function Initialize-InteractiveDisplayPreparation \{[\s\S]*Assert-VirtioGpuDriverBinding/,
    );
    assert.match(
      runtime,
      /function Prepare-InteractiveDisplay \{[\s\S]*Assert-VirtioGpuDriverBinding/,
    );
    assert.match(runtime, /driverBindingValid = \$driverBindingValid/);
    assert.match(
      runtime,
      /Win32_VideoController[\s\S]*Status -eq "OK"[\s\S]*ConfigManagerErrorCode -eq 0[\s\S]*PNPDeviceID -match "\^PCI\\\\VEN_1AF4&"/,
    );
    assert.match(runtime, /Win32_PnPSignedDriver[\s\S]*IsSigned -eq \$true/);
    assert.match(runtime, /Get-AuthenticodeSignature[\s\S]*Status -ne "Valid"/);
    assert.match(
      runtime,
      /Get-WindowsDriver -Online -Driver \$signedDriver\.InfName[\s\S]*OriginalFileName[\s\S]*\$driverInf\.Name/,
    );
    assert.match(
      runtime,
      /packageSha256[\s\S]*Get-Sha256[\s\S]*driverStoreRoot/,
    );
    assert.match(
      runtime,
      /driverStoreFiles[\s\S]*DriverStore identity is not bound to the distribution package/,
    );
    assert.match(runtime, /virtio-gpu-driver-binding\.json/);
    assert.match(runtime, /win10-kvm-guest-stage-failure\/v1/);
    assert.match(runtime, /guest-stage-failure\.json/);
    assert.match(runtime, /scriptStackTrace/);
    assert.match(
      verify,
      /virtio-gpu-driver-identity\.json[\s\S]*packageIdentity\.files[\s\S]*packageHash -cne \$ExpectedVirtioGpuDriverPackageSha256/,
    );
    assert.match(
      verify,
      /packageIdentity\.driverStoreFiles[\s\S]*binding\.files[\s\S]*DriverStore binding is not part of the published package/,
    );
    const packageFilesLoop = verify.indexOf("foreach ($file in $files)");
    const driverStoreDeclaration = verify.indexOf(
      "$driverStoreFiles = @($packageIdentity.driverStoreFiles",
    );
    const driverStoreRoot = verify.indexOf(
      "$driverStoreRoot = Split-Path -Parent",
    );
    const driverStoreLoop = verify.indexOf(
      "foreach ($file in $driverStoreFiles)",
    );
    assert.ok(
      packageFilesLoop >= 0 && packageFilesLoop < driverStoreDeclaration,
    );
    assert.ok(driverStoreLoop > driverStoreRoot);
    assert.doesNotMatch(
      runtime,
      /\/subdirs|\/add-driver[^\r\n]*\*\.inf|testsigning|nointegritychecks/i,
    );
    assert.match(
      prepareKvmGuest,
      /Install-VirtioGpuDisplayDriver -DriverRoot \$VirtioGpuDriverPath/,
    );
    assert.match(prepareKvmGuest, /Initialize-InteractiveDisplayPreparation/);
    assert.doesNotMatch(
      prepareKvmGuest,
      /Set-ClientDisplayMode|Disable-RemainingAutomaticLogon|Install-SpiceGuestTools/,
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
      prepareInteractiveDisplay,
      /Where-Object \{ \$_.Status -eq "OK" -and -not \[string\]::IsNullOrWhiteSpace\(\$_.Name\) \}/,
    );
    const clientDisplayMode = runtime.slice(
      runtime.indexOf("function Set-ClientDisplayMode"),
      runtime.indexOf("function Write-AtomicJson"),
    );
    assert.match(clientDisplayMode, /EnumDisplayDevices/);
    assert.match(clientDisplayMode, /EnumDisplaySettingsEx/);
    assert.match(clientDisplayMode, /ChangeDisplaySettingsEx/);
    assert.match(clientDisplayMode, /FindAttachedDisplayDevice/);
    assert.match(
      clientDisplayMode,
      /candidate\.dmPelsWidth == width && candidate\.dmPelsHeight == height/,
    );
    assert.match(
      clientDisplayMode,
      /not advertised by the active virtual adapter/,
    );
    assert.doesNotMatch(
      clientDisplayMode,
      /QXL|SPICE|Restart-SpiceDisplayAgent/,
    );
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
      ) < rearmInteractiveDisplay.indexOf('"shutdown.exe"'),
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
      /\$rustupPath -ArgumentList @\("toolchain", "install", "1\.96\.0-x86_64-pc-windows-msvc"/,
    );
    assert.match(
      runtime,
      /\$rustupPath = Join-Path \$cachePaths\.CARGO_HOME "bin\\rustup\.exe"/,
    );
    assert.match(
      runtime,
      /\$rustcPath = Join-Path \$cachePaths\.CARGO_HOME "bin\\rustc\.exe"/,
    );
    assert.doesNotMatch(runtime, /Invoke-Native -FilePath "rustup\.exe"/);
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
    assert.match(runtime, /"--labels", \(\$RunnerLabels -join ","\)/);
    assert.match(runtime, /choco\.exe/);
    assert.ok(runtime.indexOf("choco.exe") < runtime.indexOf("config.cmd"));
    assert.match(runtime, /vswhere\.exe/);
    assert.match(runtime, /Microsoft\.VisualStudio\.Workload\.VCTools/);
    assert.match(runtime, /cl\.exe/);
    assert.match(runtime, /MFStartup/);
    assert.match(runtime, /FilterGraph/);
    assert.match(verify, /interactive-display-report\.json/);
    assert.match(verify, /displayAdapter/);
    assert.match(verify, /ExpectedVirtioGpuDriverPackageSha256/);
    assert.match(
      verify,
      /binding\.packageSha256[\s\S]*ExpectedVirtioGpuDriverPackageSha256[\s\S]*Get-WindowsDriver[\s\S]*driverStoreRoot/,
    );
    assert.match(verify, /PNPDeviceID -ceq \[string\]\$binding\.pnpDeviceId/);
    assert.match(
      verify,
      /Where-Object \{ \$_.Status -eq "OK" -and -not \[string\]::IsNullOrWhiteSpace\(\$_.Name\) \}/,
    );
    assert.doesNotMatch(verify, /SPICEGuestTools|QXL|rebootSemanticsValid/);
    assert.doesNotMatch(verify, /PrimaryScreen/);
    assert.match(verify, /ExpectedRunnerUrl/);
    assert.match(verify, /ExpectedRunnerName/);
    assert.match(verify, /ExpectedRunnerLabels/);
    assert.match(verify, /ExpectedRunnerServiceName/);
    assert.match(verify, /registrationLabelsMatch/);
    assert.match(verify, /\$runnerRegistration\.runnerLabels/);
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
    assert.match(builder, /startHeadlessVncActivator/);
    assert.match(
      builder,
      /metadataPath: join\(\s*stagingDirectory,\s*VNC_ACTIVATOR_METADATA_FILE/,
    );
    assert.match(builder, /vncActivator\.runWhileActive/);
    assert.match(builder, /ExpectedSerialUsbPort: \[1, 2\]/);
    assert.match(builder, /ExpectedRunnerLabels: config\.runner\.labels/);
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
    assert.match(verify, /Get-Partition -DriveLetter D/);
    assert.doesNotMatch(verify, /Get-Volume -DriveLetter D/);
    assert.match(runtime, /foreach \(\$codePoint in 69\.\.90\)/);
    assert.doesNotMatch(runtime, /"E"\.\."Z"/);
    assert.match(runtime, /Join-Path \$cachePaths\.PNPM_HOME "bin"/);
    assert.match(runtime, /SetEnvironmentVariable\("Path", \$machinePath, "Machine"\)/);
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

  it("re-arms interactive display preparation when its task is absent", async () => {
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
      displayAdapter: "Microsoft Basic Display Adapter",
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
          expectedVirtioGpuDriverPackageSha256: "a".repeat(64),
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
                      ? completedInteractiveDisplayStatus("boot-after-rearm")
                      : {
                          reportValid: false,
                          reportPresent: false,
                          state: { phase: "waiting-for-logon" },
                          task: null,
                          taskLogTail:
                            "interactive display task is unexpectedly absent",
                          currentBootIdentity: "boot-current",
                        },
                  )}\n`,
                };
              }
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
                rearmed = true;
                return {
                  stdout: `${JSON.stringify(
                    completedInteractiveDisplayStatus("boot-after-rearm"),
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
      assert.match(
        readFileSync(join(stagingDirectory, "register-runner.ps1"), "utf8"),
        /-RunnerLabels @\('vem-runtime'\)/,
      );
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
        "a missing interactive display task must trigger a bounded re-arm",
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
            expectedVirtioGpuDriverPackageSha256: "a".repeat(64),
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
                    '{"reportValid":false,"reportPresent":false,"state":{"phase":"running"},"task":{"state":"Running","lastTaskResult":267009},"taskLogTail":"display task is still waiting for the portrait desktop"}\n',
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
        /interactive display preparation timed out[\s\S]*report=absent[\s\S]*task state=Running[\s\S]*lastTaskResult=267009[\s\S]*display task is still waiting for the portrait desktop/,
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
          expectedVirtioGpuDriverPackageSha256: "b".repeat(64),
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
      assert.equal(
        verifier.parameters.ExpectedVirtioGpuDriverPackageSha256,
        "b".repeat(64),
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
                            automaticLogonDisabled: false,
                          },
                        }
                      : completedInteractiveDisplayStatus("boot-final"),
                  )}\n`,
                };
              }
              if (bound.parameters.Mode === "RearmInteractiveDisplay") {
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
          automaticLogonDisabled: true,
        },
      },
      {
        ...completedInteractiveDisplayStatus(),
        cleanup: {
          taskRemoved: true,
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

  it("requires a changed boot identity after rearm despite a transient SSH failure", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-reboot-barrier-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    let sshProbes = 0;
    let rearmAttempts = 0;
    let statusPolls = 0;
    let copiedBootIdentity = null;
    let statusBootIdentity = null;
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
                const status =
                  statusPolls === 1
                    ? {
                        reportPresent: false,
                        reportValid: false,
                        state: { phase: "failed" },
                        task: null,
                        cleanup: {
                          taskRemoved: false,
                          automaticLogonDisabled: false,
                        },
                        currentBootIdentity: "boot-before-rearm",
                      }
                    : completedInteractiveDisplayStatus(
                        statusPolls <= 3
                          ? "boot-before-rearm"
                          : "boot-after-rearm",
                      );
                statusBootIdentity = status.currentBootIdentity;
                return {
                  stdout: `${JSON.stringify(status)}\n`,
                };
              }
            }
            if (command === "scp") {
              copiedBootIdentity = statusBootIdentity;
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

  it("obtains an initial boot identity before rearming interactive display", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-initial-boot-identity-"),
    );
    const config = buildConfig(stagingDirectory);
    let now = 0;
    let rearmAttempts = 0;
    let statusPolls = 0;
    try {
      await waitForInteractiveDisplayReport(
        config,
        "win10-runtime-baseline-build-test",
        stagingDirectory,
        {
          discoverGuestAddress: async () => "192.0.2.44",
          initialRearmDelayMs: 0,
          maxRearmAttempts: 1,
          now: () => now,
          pollIntervalMs: 1,
          runCommand: async (command, args) => {
            const remoteCommand = args.at(-1) ?? "";
            if (command === "ssh" && remoteCommand === "exit") return {};
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
                const status =
                  statusPolls === 1
                    ? {
                        reportPresent: false,
                        reportValid: false,
                        state: { phase: "failed" },
                        task: null,
                        cleanup: {
                          taskRemoved: false,
                          automaticLogonDisabled: false,
                        },
                        currentBootIdentity: null,
                      }
                    : statusPolls === 2
                      ? {
                          reportPresent: false,
                          reportValid: false,
                          state: { phase: "failed" },
                          task: null,
                          cleanup: {
                            taskRemoved: false,
                            automaticLogonDisabled: false,
                          },
                          currentBootIdentity: "boot-before-rearm",
                        }
                      : completedInteractiveDisplayStatus("boot-after-rearm");
                return { stdout: `${JSON.stringify(status)}\n` };
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

      assert.equal(rearmAttempts, 1);
      assert.equal(statusPolls, 3);
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

  it("gives first SSH readiness at 59:59.999 an independent full display deadline", async () => {
    const stagingDirectory = mkdtempSync(
      join(tmpdir(), "vem-kvm-display-boundary-deadline-"),
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
            discoverGuestAddress: async () =>
              now >= 60 * 60 * 1000 - 1 ? "192.0.2.44" : null,
            displayStageTimeoutMs: 2,
            guestAvailabilityTimeoutMs: 60 * 60 * 1000,
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
                    task: { state: "Running" },
                    cleanup: {
                      taskRemoved: false,
                      automaticLogonDisabled: false,
                    },
                    currentBootIdentity: "boot-display",
                  })}\n`,
                };
              }
              throw new Error(`unexpected command: ${command}`);
            },
            sleep: async () => {
              now = now === 0 ? 60 * 60 * 1000 - 1 : now + 1;
            },
          },
        ),
        /interactive display stage timed out after 2 ms[\s\S]*first SSH readiness at 3599999 ms/,
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

  it("retains construction staging when domain absence cannot be confirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-cleanup-confirmation-"));
    const systemStagingPath = join(root, "system-staging");
    const cacheStagingPath = join(root, "cache-staging");
    mkdirSync(systemStagingPath, { recursive: true });
    mkdirSync(cacheStagingPath, { recursive: true });
    const cleanup = constructionCleanup({
      cacheStagingDirectory: cacheStagingPath,
      config: { host: { libvirtUri: "qemu:///system" } },
      constructionDomain: "win10-runtime-baseline-build-deadbeef",
      runCommand: async (_command, args) => {
        if (args[2] === "dominfo") return { stdout: "", failed: true };
        if (args[2] === "list") throw new Error("libvirt unavailable");
        return { stdout: "" };
      },
      stagingDirectory: systemStagingPath,
    });
    try {
      await assert.rejects(cleanup(), /libvirt unavailable/);
      assert.equal(existsSync(systemStagingPath), true);
      assert.equal(existsSync(cacheStagingPath), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops the VNC activator before tracked domain cleanup and staging deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-activator-cleanup-"));
    const systemStagingPath = join(root, "system-staging");
    const cacheStagingPath = join(root, "cache-staging");
    const events = [];
    mkdirSync(systemStagingPath, { recursive: true });
    mkdirSync(cacheStagingPath, { recursive: true });
    const cleanup = constructionCleanup({
      cacheStagingDirectory: cacheStagingPath,
      config: { host: { libvirtUri: "qemu:///system" } },
      constructionDomain: "win10-runtime-baseline-build-deadbeef",
      runCommand: async (_command, args) => {
        events.push(args[2]);
        return { stdout: "" };
      },
      stagingDirectory: systemStagingPath,
      stopActivator: async () => events.push("activator-stop"),
    });
    try {
      await cleanup();
      assert.deepEqual(events, [
        "activator-stop",
        "destroy",
        "undefine",
        "list",
      ]);
      assert.equal(existsSync(systemStagingPath), false);
      assert.equal(existsSync(cacheStagingPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates in-flight execFile children before cleanup and blocks a late domain creator", () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-kvm-construction-tracked-sigterm-"),
    );
    const childPath = join(root, "construction-tracked-sigterm-child.mjs");
    const fakeVirshPath = join(root, "bin", "virsh");
    const longChildPath = join(root, "long-lived-command.mjs");
    const lateDomainCreatorPath = join(root, "late-domain-creator.mjs");
    const domainName = "win10-runtime-baseline-build-deadbeef";
    const domainPath = join(root, "domain-defined");
    const systemStagingPath = join(root, "system-staging");
    const cacheStagingPath = join(root, "cache-staging");
    const virshLogPath = join(root, "virsh.log");
    const domainGoneReceiptPath = join(
      root,
      "domain-gone-before-staging-cleanup",
    );
    const longChildPidPath = join(root, "long-child.pid");
    const longChildReadyPath = join(root, "long-child.ready");
    const lateDomainMarkerPath = join(root, "late-domain-created");
    try {
      writeFileSync(childPath, trackedConstructionSignalCleanupChildSource());
      mkdirSync(dirname(fakeVirshPath), { recursive: true });
      writeFileSync(
        fakeVirshPath,
        `#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
const operation = process.argv[4];
appendFileSync(process.env.FAKE_VIRSH_LOG, operation + "\\n");
if (operation === "undefine") rmSync(process.env.FAKE_DOMAIN_PATH, { force: true });
if (operation === "list") {
  if (existsSync(process.env.FAKE_DOMAIN_PATH)) {
    process.stdout.write(process.env.FAKE_DOMAIN_NAME + "\\n");
    process.exit(0);
  }
  if (!existsSync(process.env.FAKE_SYSTEM_STAGING) || !existsSync(process.env.FAKE_CACHE_STAGING)) process.exit(9);
  writeFileSync(process.env.FAKE_DOMAIN_GONE_RECEIPT, "confirmed");
}
`,
      );
      chmodSync(fakeVirshPath, 0o755);
      writeFileSync(
        longChildPath,
        `
import { writeFile } from "node:fs/promises";
const [pidPath, readyPath] = process.argv.slice(2);
await writeFile(pidPath, String(process.pid));
await writeFile(readyPath, "ready");
await new Promise(() => setInterval(() => {}, 1_000));
`,
      );
      writeFileSync(
        lateDomainCreatorPath,
        `
import { mkdir, writeFile } from "node:fs/promises";
const [domainPath, markerPath] = process.argv.slice(2);
await mkdir(domainPath, { recursive: true });
await writeFile(markerPath, "created");
`,
      );
      writeFileSync(domainPath, domainName);
      mkdirSync(systemStagingPath, { recursive: true });
      mkdirSync(cacheStagingPath, { recursive: true });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
            set -euo pipefail
            node "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" &
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
          systemStagingPath,
          cacheStagingPath,
          longChildPath,
          longChildPidPath,
          longChildReadyPath,
          lateDomainCreatorPath,
          lateDomainMarkerPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dirname(fakeVirshPath)}:${process.env.PATH}`,
            FAKE_VIRSH_LOG: virshLogPath,
            FAKE_DOMAIN_PATH: domainPath,
            FAKE_DOMAIN_NAME: domainName,
            FAKE_SYSTEM_STAGING: systemStagingPath,
            FAKE_CACHE_STAGING: cacheStagingPath,
            FAKE_DOMAIN_GONE_RECEIPT: domainGoneReceiptPath,
          },
        },
      );

      assert.equal(result.status, 143, result.stderr);
      assert.equal(existsSync(domainPath), false);
      assert.equal(existsSync(systemStagingPath), false);
      assert.equal(existsSync(cacheStagingPath), false);
      assert.equal(existsSync(lateDomainMarkerPath), false);
      assert.equal(readFileSync(domainGoneReceiptPath, "utf8"), "confirmed");
      assert.deepEqual(readFileSync(virshLogPath, "utf8").trim().split("\n"), [
        "destroy",
        "undefine",
        "list",
      ]);
      const longChildPid = Number(readFileSync(longChildPidPath, "utf8"));
      assert.throws(() => process.kill(longChildPid, 0), /ESRCH/);
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
    assert.ok(completionChecks[1].index < rearm.indexOf('"shutdown.exe"'));
    assert.match(
      rearm,
      /Invoke-Native -FilePath "shutdown\.exe" -ArgumentList @\("\/r", "\/t", "0", "\/f"\)/,
    );
    assert.match(rearm, /Start-Sleep -Seconds 60/);
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
    assert.match(
      runtime,
      /completionValid = \$driverBindingValid -and \(Test-InteractiveDisplayReport/,
    );
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

  it("uses the same latest-wins concurrency group while baseline owns its host lock", () => {
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
    assert.match(baselineWorkflow, /VEM_VM_HOST_LOCK_PATH/);
    assert.match(baselineWorkflow, /flock -n/);
    assert.doesNotMatch(baselineWorkflow, /mkdir "\$VEM_VM_HOST_LOCK_PATH"/);
    assert.doesNotMatch(
      baselineWorkflow,
      /rm -rf -- "\$VEM_VM_HOST_LOCK_PATH"/,
    );
  });

  it("terminates the lock holder process group and releases its flock within five seconds", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-flock-"));
    const lockPath = join(root, "vem-windows-runtime-testbed.lock");
    const ownerPath = join(root, "lock-owner");
    try {
      const cancelled = spawnSync(
        "bash",
        [
          "-c",
          `
            set -euo pipefail
            lock_path="$1"
            owner_path="$2"
            setsid flock -n "$lock_path" bash -c '
              owner_path="$1"
              trap "exit 0" TERM INT
              lock_pgid=$(ps -o pgid= -p "$$" | tr -d "[:space:]")
              printf "%s %s\\n" "$$" "$lock_pgid" > "$owner_path"
              while :; do sleep 60 & wait "$!"; done
            ' _ "$owner_path" &
            holder="$!"
            for _ in $(seq 1 50); do
              [[ -s "$owner_path" ]] && break
              sleep 0.1
            done
            read -r shell_pid lock_pgid < "$owner_path"
            flock_pid=$(ps -o ppid= -p "$shell_pid" | tr -d "[:space:]")
            sleep_pid=$(pgrep -P "$shell_pid" sleep)
            [[ "$(ps -o comm= -p "$flock_pid" | tr -d "[:space:]")" = flock ]]
            [[ -n "$sleep_pid" ]]
            kill -TERM -- "-$lock_pgid"
            for _ in $(seq 1 100); do
              if flock -n "$lock_path" true; then
                wait "$holder" || true
                exit 0
              fi
              sleep 0.05
            done
            exit 1
          `,
          "_",
          lockPath,
          ownerPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(cancelled.status, 0, cancelled.stderr);
      assert.equal(spawnSync("flock", ["-n", lockPath, "true"]).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers only exact generated construction domains and preserves deployment and backup names", async () => {
    const config = buildConfig("/var/tmp/vem-kvm-baseline-recovery");
    const invocations = [];
    const definedDomains = new Set([
      "win10-runtime-baseline-build-0123abcd",
      "win10-runtime-baseline-build-deadbeef",
    ]);
    const protectedDomains = [
      "win10-runtime-baseline-deployment",
      "win10-runtime-baseline-backup",
      "win10-runtime-baseline-build-0123abcd-backup",
      "win10-runtime-baseline-build-0123abcd-extra",
      "win10-runtime-baseline-build-0123456",
      "win10-runtime-baseline-build-012345678",
      "win10-runtime-baseline-build-0123456g",
      "win10-runtime-baseline-build-ABCDEF12",
      "win10-runtime-baseline-build-old-a",
      "win10-runtime-baseline2-build-old",
      "other-build-old",
    ];
    const runCommand = async (command, args, options) => {
      invocations.push({ command, args, options });
      if (args.includes("list")) {
        return {
          stdout: [...definedDomains, ...protectedDomains].join("\n"),
        };
      }
      if (args[2] === "undefine") definedDomains.delete(args[3]);
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
          "win10-runtime-baseline-build-0123abcd",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "undefine",
          "win10-runtime-baseline-build-0123abcd",
        ],
        options: { allowFailure: true },
      },
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
          "win10-runtime-baseline-build-deadbeef",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: [
          "--connect",
          "qemu:///system",
          "undefine",
          "win10-runtime-baseline-build-deadbeef",
        ],
        options: { allowFailure: true },
      },
      {
        command: "virsh",
        args: ["--connect", "qemu:///system", "list", "--all", "--name"],
        options: undefined,
      },
    ]);
  });

  it("reclaims only metadata-owned construction staging after a hard crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-hard-crash-recovery-"));
    const config = buildConfig(root);
    config.storage.cacheDiskPath = join(
      root,
      "cache",
      "win10-runtime-cache.qcow2",
    );
    const buildId = "deadbeef";
    const domainName = `${config.vm.name}-build-${buildId}`;
    const systemStagingPath = join(
      dirname(config.storage.baselinePath),
      `.${config.vm.name}.staging-${buildId}`,
    );
    const cacheStagingPath = join(
      dirname(config.storage.cacheDiskPath),
      `.${config.vm.name}.cache-staging-${buildId}`,
    );
    const unownedSystemPath = join(
      dirname(config.storage.baselinePath),
      `.${config.vm.name}.staging-0123abcd`,
    );
    const unownedCachePath = join(
      dirname(config.storage.cacheDiskPath),
      `.${config.vm.name}.cache-staging-0123abcd`,
    );
    const orphanBuildId = "cafebabe";
    const orphanSystemPath = join(
      dirname(config.storage.baselinePath),
      `.${config.vm.name}.staging-${orphanBuildId}`,
    );
    const orphanCachePath = join(
      dirname(config.storage.cacheDiskPath),
      `.${config.vm.name}.cache-staging-${orphanBuildId}`,
    );
    const backupPath = `${systemStagingPath}-backup`;
    const metadata = {
      schemaVersion: "win10-kvm-construction-owner/v1",
      buildId,
      vmName: config.vm.name,
      domainName,
      baselinePath: config.storage.baselinePath,
      cacheDiskPath: config.storage.cacheDiskPath,
      systemStagingPath,
      cacheStagingPath,
    };
    const orphanMetadata = {
      ...metadata,
      buildId: orphanBuildId,
      domainName: `${config.vm.name}-build-${orphanBuildId}`,
      systemStagingPath: orphanSystemPath,
      cacheStagingPath: orphanCachePath,
    };
    const definedDomains = new Set([domainName]);
    const invocations = [];
    const runCommand = async (command, args, options) => {
      invocations.push({ command, args, options });
      const operation = args[2];
      if (operation === "list") {
        return { stdout: [...definedDomains].join("\n") };
      }
      if (operation === "undefine") definedDomains.delete(args[3]);
      return { stdout: "" };
    };

    try {
      for (const path of [
        systemStagingPath,
        cacheStagingPath,
        unownedSystemPath,
        unownedCachePath,
        orphanSystemPath,
        orphanCachePath,
        backupPath,
      ]) {
        mkdirSync(path, { recursive: true });
        const remnant = join(path, "large-remnant.qcow2");
        writeFileSync(remnant, "");
        truncateSync(remnant, 64 * 1024 * 1024);
      }
      writeFileSync(
        join(systemStagingPath, ".construction-owner.json"),
        `${JSON.stringify(metadata)}\n`,
      );
      writeFileSync(
        join(cacheStagingPath, ".construction-owner.json"),
        `${JSON.stringify(metadata)}\n`,
      );
      writeFileSync(
        join(orphanSystemPath, ".construction-owner.json"),
        `${JSON.stringify(orphanMetadata)}\n`,
      );
      writeFileSync(
        join(orphanCachePath, ".construction-owner.json"),
        `${JSON.stringify(orphanMetadata)}\n`,
      );

      await recoverStaleConstructionDomains(config, { runCommand });

      assert.equal(existsSync(systemStagingPath), false);
      assert.equal(existsSync(cacheStagingPath), false);
      assert.equal(existsSync(orphanSystemPath), false);
      assert.equal(existsSync(orphanCachePath), false);
      assert.equal(existsSync(unownedSystemPath), true);
      assert.equal(existsSync(unownedCachePath), true);
      assert.equal(existsSync(backupPath), true);
      assert.deepEqual(
        invocations.map(({ args }) => args[2]),
        ["list", "destroy", "undefine", "list"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "recovers exact durable activator children after builder SIGKILL without touching unrelated processes",
    { timeout: 10_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-kvm-activator-sigkill-"));
      const config = buildConfig(root);
      config.storage.cacheDiskPath = join(
        root,
        "cache",
        "win10-runtime-cache.qcow2",
      );
      const configPath = join(root, "config.json");
      const childPath = join(root, "hard-crash-child.mjs");
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-viewer.mjs");
      const unrelatedPath = join(root, "unrelated.pid");
      const readyPath = join(root, "ready.json");
      const xvfbTargetPath = join(root, "xvfb-target.pid");
      const windowManagerTargetPath = join(root, "window-manager-target.pid");
      const viewerTargetPath = join(root, "viewer-target.pid");
      let builderChild;
      let unrelated;
      let targetPids = [];
      try {
        mkdirSync(dirname(config.storage.baselinePath), { recursive: true });
        mkdirSync(dirname(config.storage.cacheDiskPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(config));
        writeFileSync(childPath, hardCrashActivatorChildSource());
        writeFileSync(
          xvfbPath,
          'import { writeFileSync } from "node:fs"; writeFileSync(process.env.XVFB_TARGET_PATH, String(process.pid)); process.stdout.write("81\\n"); await new Promise(() => setInterval(() => {}, 1_000));\n',
        );
        writeFileSync(
          viewerPath,
          `
import { writeFile } from "node:fs/promises";
if (process.env.UNRELATED_PID_PATH) await writeFile(process.env.UNRELATED_PID_PATH, String(process.pid));
if (process.env.VIEWER_TARGET_PATH) await writeFile(process.env.VIEWER_TARGET_PATH, String(process.pid));
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          windowManagerPath,
          'import { writeFileSync } from "node:fs"; writeFileSync(process.env.WINDOW_MANAGER_TARGET_PATH, String(process.pid)); await new Promise(() => setInterval(() => {}, 1_000));\n',
        );
        unrelated = spawn(process.execPath, [viewerPath], {
          env: { ...process.env, UNRELATED_PID_PATH: unrelatedPath },
          stdio: "ignore",
        });
        builderChild = spawn(
          process.execPath,
          [
            childPath,
            configPath,
            xvfbPath,
            windowManagerPath,
            viewerPath,
            readyPath,
          ],
          {
            env: {
              ...process.env,
              VIEWER_TARGET_PATH: viewerTargetPath,
              WINDOW_MANAGER_TARGET_PATH: windowManagerTargetPath,
              XVFB_TARGET_PATH: xvfbTargetPath,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const deadline = Date.now() + 5_000;
        while (
          (!existsSync(readyPath) || !existsSync(unrelatedPath)) &&
          Date.now() < deadline
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        assert.equal(existsSync(readyPath), true);
        assert.equal(existsSync(unrelatedPath), true);
        const { metadataPath, owner } = JSON.parse(
          readFileSync(readyPath, "utf8"),
        );
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        const activatorPids = Object.values(metadata.processes).map(
          (identity) => identity.pid,
        );
        const unrelatedPid = Number(readFileSync(unrelatedPath, "utf8"));
        targetPids = [
          xvfbTargetPath,
          windowManagerTargetPath,
          viewerTargetPath,
        ].map((path) => Number(readFileSync(path, "utf8")));

        const crashedSupervisorPid = metadata.processes.viewer.pid;
        process.kill(crashedSupervisorPid, "SIGKILL");
        const supervisorDeadline = Date.now() + 2_000;
        while (Date.now() < supervisorDeadline) {
          try {
            process.kill(crashedSupervisorPid, 0);
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          } catch (error) {
            if (error.code === "ESRCH") break;
            throw error;
          }
        }
        assertProcessIsNotRunning(crashedSupervisorPid);
        assertProcessIsNotRunning(metadata.targets.viewer.pid);

        builderChild.kill("SIGKILL");
        await once(builderChild, "exit");
        for (const pid of [
          ...activatorPids.filter((pid) => pid !== crashedSupervisorPid),
          ...targetPids.slice(0, 2),
        ]) {
          assert.doesNotThrow(() => process.kill(pid, 0));
        }

        const domains = new Set([owner.domainName]);
        await recoverStaleConstructionDomains(config, {
          runCommand: async (_command, args) => {
            if (args[2] === "list") return { stdout: [...domains].join("\n") };
            if (args[2] === "undefine") domains.delete(args[3]);
            return { stdout: "" };
          },
        });

        for (const pid of [...activatorPids, ...targetPids]) {
          assertProcessIsNotRunning(pid);
        }
        assert.doesNotThrow(() => process.kill(unrelatedPid, 0));
        assert.equal(existsSync(owner.systemStagingPath), false);
        assert.equal(existsSync(owner.cacheStagingPath), false);
        assert.equal(domains.size, 0);
      } finally {
        if (
          builderChild?.exitCode === null &&
          builderChild.signalCode === null
        ) {
          builderChild.kill("SIGKILL");
          await once(builderChild, "exit");
        }
        if (unrelated?.exitCode === null && unrelated.signalCode === null) {
          unrelated.kill("SIGKILL");
          await once(unrelated, "exit");
        }
        for (const pid of targetPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "recovers an Xvfb launch stopped before durable identity publication without starting its target",
    { timeout: 10_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-kvm-xvfb-launch-sigkill-"));
      const config = buildConfig(root);
      config.storage.cacheDiskPath = join(
        root,
        "cache",
        "win10-runtime-cache.qcow2",
      );
      const configPath = join(root, "config.json");
      const childPath = join(root, "launch-window-child.mjs");
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-viewer.mjs");
      const statePath = join(root, "launch-state.json");
      const xvfbTargetPath = join(root, "xvfb-target.json");
      const unrelatedPath = join(root, "unrelated.pid");
      let builderChild;
      let unrelated;
      let launchPid;
      try {
        mkdirSync(dirname(config.storage.baselinePath), { recursive: true });
        mkdirSync(dirname(config.storage.cacheDiskPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(config));
        writeFileSync(childPath, launchWindowCrashActivatorChildSource());
        writeFileSync(
          xvfbPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.XVFB_TARGET_PATH, JSON.stringify({ pid: process.pid }));
process.stdout.write("91\\n");
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          viewerPath,
          `
import { writeFileSync } from "node:fs";
if (process.env.UNRELATED_PID_PATH) writeFileSync(process.env.UNRELATED_PID_PATH, String(process.pid));
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        unrelated = spawn(process.execPath, [viewerPath], {
          env: { ...process.env, UNRELATED_PID_PATH: unrelatedPath },
          stdio: "ignore",
        });
        builderChild = spawn(
          process.execPath,
          [
            childPath,
            configPath,
            xvfbPath,
            viewerPath,
            viewerPath,
            statePath,
            "xvfb",
          ],
          {
            env: { ...process.env, XVFB_TARGET_PATH: xvfbTargetPath },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const deadline = Date.now() + 5_000;
        while (
          (!existsSync(statePath) || !existsSync(unrelatedPath)) &&
          Date.now() < deadline
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        assert.equal(existsSync(statePath), true);
        assert.equal(existsSync(unrelatedPath), true);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        launchPid = state.launchPid;
        assert.equal(existsSync(state.metadataPath), false);

        builderChild.kill("SIGKILL");
        await once(builderChild, "exit");
        process.kill(launchPid, "SIGCONT");
        const registrationDeadline = Date.now() + 2_000;
        while (
          !existsSync(state.metadataPath) &&
          !existsSync(xvfbTargetPath) &&
          Date.now() < registrationDeadline
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }

        const domains = new Set([state.owner.domainName]);
        await recoverStaleConstructionDomains(config, {
          runCommand: async (_command, args) => {
            if (args[2] === "list") return { stdout: [...domains].join("\n") };
            if (args[2] === "undefine") domains.delete(args[3]);
            return { stdout: "" };
          },
        });

        assertProcessIsNotRunning(launchPid);
        assert.equal(existsSync(xvfbTargetPath), false);
        assert.doesNotThrow(() =>
          process.kill(Number(readFileSync(unrelatedPath, "utf8")), 0),
        );
        assert.equal(existsSync(state.owner.systemStagingPath), false);
        assert.equal(existsSync(state.owner.cacheStagingPath), false);
        assert.equal(domains.size, 0);
      } finally {
        if (
          builderChild?.exitCode === null &&
          builderChild.signalCode === null
        ) {
          builderChild.kill("SIGKILL");
          await once(builderChild, "exit");
        }
        if (launchPid) {
          try {
            process.kill(launchPid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        if (unrelated?.exitCode === null && unrelated.signalCode === null) {
          unrelated.kill("SIGKILL");
          await once(unrelated, "exit");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "recovers a viewer launch stopped before durable identity publication without starting its target",
    { timeout: 10_000 },
    async () => {
      const root = mkdtempSync(
        join(tmpdir(), "vem-kvm-viewer-launch-sigkill-"),
      );
      const config = buildConfig(root);
      config.storage.cacheDiskPath = join(
        root,
        "cache",
        "win10-runtime-cache.qcow2",
      );
      const configPath = join(root, "config.json");
      const childPath = join(root, "launch-window-child.mjs");
      const xvfbPath = join(root, "fake-xvfb.mjs");
      const windowManagerPath = join(root, "fake-window-manager.mjs");
      const viewerPath = join(root, "fake-viewer.mjs");
      const statePath = join(root, "launch-state.json");
      const xvfbTargetPath = join(root, "xvfb-target.json");
      const windowManagerTargetPath = join(root, "window-manager-target.json");
      const viewerTargetPath = join(root, "viewer-target.json");
      const unrelatedPath = join(root, "unrelated.pid");
      let builderChild;
      let unrelated;
      let launchPid;
      let xvfbTargetPid;
      let windowManagerTargetPid;
      try {
        mkdirSync(dirname(config.storage.baselinePath), { recursive: true });
        mkdirSync(dirname(config.storage.cacheDiskPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(config));
        writeFileSync(childPath, launchWindowCrashActivatorChildSource());
        writeFileSync(
          xvfbPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.XVFB_TARGET_PATH, JSON.stringify({ pid: process.pid }));
process.stdout.write("92\\n");
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          viewerPath,
          `
import { writeFileSync } from "node:fs";
if (process.env.UNRELATED_PID_PATH) writeFileSync(process.env.UNRELATED_PID_PATH, String(process.pid));
if (process.env.VIEWER_TARGET_PATH) writeFileSync(process.env.VIEWER_TARGET_PATH, JSON.stringify({ pid: process.pid }));
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        writeFileSync(
          windowManagerPath,
          `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.WINDOW_MANAGER_TARGET_PATH, JSON.stringify({ pid: process.pid }));
await new Promise(() => setInterval(() => {}, 1_000));
`,
        );
        unrelated = spawn(process.execPath, [viewerPath], {
          env: { ...process.env, UNRELATED_PID_PATH: unrelatedPath },
          stdio: "ignore",
        });
        builderChild = spawn(
          process.execPath,
          [
            childPath,
            configPath,
            xvfbPath,
            windowManagerPath,
            viewerPath,
            statePath,
            "viewer",
          ],
          {
            env: {
              ...process.env,
              VIEWER_TARGET_PATH: viewerTargetPath,
              WINDOW_MANAGER_TARGET_PATH: windowManagerTargetPath,
              XVFB_TARGET_PATH: xvfbTargetPath,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const deadline = Date.now() + 5_000;
        while (
          (!existsSync(statePath) ||
            !existsSync(unrelatedPath) ||
            !existsSync(xvfbTargetPath) ||
            !existsSync(windowManagerTargetPath)) &&
          Date.now() < deadline
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        assert.equal(existsSync(statePath), true);
        assert.equal(existsSync(unrelatedPath), true);
        assert.equal(existsSync(xvfbTargetPath), true);
        assert.equal(existsSync(windowManagerTargetPath), true);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        launchPid = state.launchPid;
        xvfbTargetPid = JSON.parse(readFileSync(xvfbTargetPath, "utf8")).pid;
        windowManagerTargetPid = JSON.parse(
          readFileSync(windowManagerTargetPath, "utf8"),
        ).pid;
        const beforeCrash = JSON.parse(
          readFileSync(state.metadataPath, "utf8"),
        );
        assert.deepEqual(Object.keys(beforeCrash.processes), [
          "xvfb",
          "window-manager",
        ]);

        builderChild.kill("SIGKILL");
        await once(builderChild, "exit");
        process.kill(launchPid, "SIGCONT");
        const registrationDeadline = Date.now() + 2_000;
        while (Date.now() < registrationDeadline) {
          const metadata = JSON.parse(readFileSync(state.metadataPath, "utf8"));
          if (metadata.processes.viewer) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }

        const domains = new Set([state.owner.domainName]);
        await recoverStaleConstructionDomains(config, {
          runCommand: async (_command, args) => {
            if (args[2] === "list") return { stdout: [...domains].join("\n") };
            if (args[2] === "undefine") domains.delete(args[3]);
            return { stdout: "" };
          },
        });

        assertProcessIsNotRunning(launchPid);
        assertProcessIsNotRunning(xvfbTargetPid);
        assertProcessIsNotRunning(windowManagerTargetPid);
        assert.equal(existsSync(viewerTargetPath), false);
        assert.doesNotThrow(() =>
          process.kill(Number(readFileSync(unrelatedPath, "utf8")), 0),
        );
        assert.equal(existsSync(state.owner.systemStagingPath), false);
        assert.equal(existsSync(state.owner.cacheStagingPath), false);
        assert.equal(domains.size, 0);
      } finally {
        if (
          builderChild?.exitCode === null &&
          builderChild.signalCode === null
        ) {
          builderChild.kill("SIGKILL");
          await once(builderChild, "exit");
        }
        for (const pid of [launchPid, xvfbTargetPid, windowManagerTargetPid]) {
          if (!pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        if (unrelated?.exitCode === null && unrelated.signalCode === null) {
          unrelated.kill("SIGKILL");
          await once(unrelated, "exit");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves an unowned cache staging collision while allocating a new build identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-workspace-collision-"));
    const config = buildConfig(root);
    config.storage.cacheDiskPath = join(
      root,
      "cache",
      "win10-runtime-cache.qcow2",
    );
    const collidedCachePath = join(
      dirname(config.storage.cacheDiskPath),
      `.${config.vm.name}.cache-staging-deadbeef`,
    );
    const sentinelPath = join(collidedCachePath, "operator-remnant.qcow2");
    const buildIds = ["deadbeef", "cafebabe"];
    try {
      mkdirSync(dirname(config.storage.baselinePath), { recursive: true });
      mkdirSync(collidedCachePath, { recursive: true });
      writeFileSync(sentinelPath, "preserve");
      const baseline = await import("./build-win10-baseline.mjs");

      const workspace = await baseline.createConstructionWorkspace(config, {
        nextBuildId: () => buildIds.shift(),
      });

      assert.equal(workspace.buildId, "cafebabe");
      assert.equal(readFileSync(sentinelPath, "utf8"), "preserve");
      rmSync(workspace.systemStagingPath, { recursive: true, force: true });
      rmSync(workspace.cacheStagingPath, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
