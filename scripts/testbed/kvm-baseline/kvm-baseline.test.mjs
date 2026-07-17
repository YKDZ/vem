import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
} from "./build-win10-baseline.mjs";
import {
  createRuntimeProfile,
  renderLibvirtDomainXml,
} from "./libvirt-runtime-profile.mjs";
import {
  evaluateHostPreflight,
  parseGuestAddress,
  promoteVerifiedBaseline,
  readJsonWithBom,
  replaceFilesTransaction,
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
      spiceGuestToolsInstallerPath: join(
        root,
        "media",
        "spice-guest-tools-0.141.exe",
      ),
      webView2InstallerUri: "https://downloads.example.test/webview2.exe",
      runnerArchiveUri: "https://downloads.example.test/actions-runner.zip",
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
    assert.match(xml, /alias name="serial-scanner"/);
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
          },
          networkActive: true,
          storageAvailableBytes: {
            baseline: 80 * 1024 ** 3,
            cache: 80 * 1024 ** 3,
          },
        }),
        { ok: true },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only replaces the published baseline after a verified staged image exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-promote-"));
    const baselinePath = join(root, "images", "win10.qcow2");
    const stagedPath = join(root, "images", ".staging", "win10.qcow2");
    try {
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(baselinePath, "previous");
      assert.rejects(
        promoteVerifiedBaseline({ stagedPath, baselinePath, verified: false }),
        /verification/,
      );
      assert.equal(readFileSync(baselinePath, "utf8"), "previous");

      writeFileSync(stagedPath, "verified");
      await promoteVerifiedBaseline({
        stagedPath,
        baselinePath,
        verified: true,
      });
      assert.equal(readFileSync(baselinePath, "utf8"), "verified");
      assert.equal(existsSync(stagedPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back every published artifact when a later publication stage fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-rollback-"));
    const system = join(root, "system.qcow2");
    const diagnostic = join(root, "system.qcow2.diagnostic.json");
    const domainXml = join(root, "system.qcow2.domain.xml");
    const stagedSystem = join(root, "staged-system.qcow2");
    const stagedDiagnostic = join(root, "staged-diagnostic.json");
    const stagedDomainXml = join(root, "staged-domain.xml");
    try {
      writeFileSync(system, "previous-system");
      writeFileSync(diagnostic, "previous-diagnostic");
      writeFileSync(domainXml, "previous-domain-xml");
      writeFileSync(stagedSystem, "verified-system");
      writeFileSync(stagedDiagnostic, "verified-diagnostic");
      writeFileSync(stagedDomainXml, "verified-domain-xml");
      await assert.rejects(
        replaceFilesTransaction(
          [
            { stagedPath: stagedSystem, destinationPath: system },
            { stagedPath: stagedDiagnostic, destinationPath: diagnostic },
            { stagedPath: stagedDomainXml, destinationPath: domainXml },
          ],
          async (_entry, count) => {
            if (count === 3) throw new Error("injected remote define failure");
          },
        ),
        /injected remote define failure/,
      );
      assert.equal(readFileSync(system, "utf8"), "previous-system");
      assert.equal(readFileSync(diagnostic, "utf8"), "previous-diagnostic");
      assert.equal(readFileSync(domainXml, "utf8"), "previous-domain-xml");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    assert.match(
      xml,
      /C:\\ProgramData\\WindowsRuntimeBaseline\\media/,
    );
    const specializeCommand = /<settings pass="specialize">[\s\S]*?<Path>([^<]+)<\/Path>/.exec(
      xml,
    )?.[1];
    assert.ok(specializeCommand);
    assert.ok(
      specializeCommand.length < 260,
      "specialize RunSynchronous Path must fit the Win10 WCM scalar limit",
    );
    assert.match(specializeCommand, /if exist %d:\\baseline-config\.json xcopy/);
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
      const commands = [];
      const stagingDirectory = join(root, "staging");
      await createConfigurationMedia(config, stagingDirectory, {
        runCommand: async (...command) => commands.push(command),
      });

      const mediaRoot = join(stagingDirectory, "configuration-media");
      assert.deepEqual(guestConfigurationFor(config), {
        webView2InstallerUri: config.media.webView2InstallerUri,
        spiceGuestToolsInstallerFile: SPICE_GUEST_TOOLS_INSTALLER_FILE,
        display: { width: 1080, height: 1920, scalePercent: 100 },
      });
      assert.equal(
        readFileSync(join(mediaRoot, SPICE_GUEST_TOOLS_INSTALLER_FILE), "utf8"),
        "spice-tools",
      );
      assert.match(
        bootstrapScript(),
        /-SpiceGuestToolsInstallerPath \(Join-Path \$mediaRoot \$config\.spiceGuestToolsInstallerFile\)/,
      );
      assert.doesNotMatch(bootstrapScript(), /Win32_CDROMDrive/);
      assert.deepEqual(commands[0][0], "xorriso");
      assert.ok(commands[0][1].includes(mediaRoot));
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
    assert.match(shared, /SpiceGuestToolsInstallerPath/);
    assert.match(shared, /New-ScheduledTaskPrincipal -UserId "SYSTEM"/);
    assert.match(shared, /-Argument "\/S"/);
    assert.match(shared, /exitCode -eq 3010/);
    assert.match(shared, /exitCode -eq 1641/);
    const spiceInstallFunction = shared.slice(
      shared.indexOf("function Install-SpiceGuestTools"),
      shared.indexOf("function Disable-RemainingAutomaticLogon"),
    );
    assert.ok(
      spiceInstallFunction.indexOf("phase = \"installing\"") <
        spiceInstallFunction.indexOf(
          "Invoke-SpiceGuestToolsInstallerAsSystem",
        ),
      "the reboot resume state must be durable before the installer starts",
    );
    assert.ok(
      spiceInstallFunction.indexOf("Register-SpiceGuestToolsResume") <
        spiceInstallFunction.indexOf(
          "Invoke-SpiceGuestToolsInstallerAsSystem",
        ),
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
      shared.indexOf("Install-SpiceGuestTools") <
        shared.indexOf("Set-ClientDisplayMode -Width"),
    );
    assert.match(shared, /PlugPlay/);
    assert.match(shared, /W32Time/);
    assert.match(shared, /Stop-Service/);
    assert.match(shared, /CDS_UPDATEREGISTRY/);
    assert.match(shared, /interactive-display-report\.json/);
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
    assert.match(builder, /UserKnownHostsFile=/);
    assert.match(builder, /<Group>Administrators<\/Group>/);
    assert.match(builder, /readJsonWithBom/);
    assert.match(builder, /domifaddr/);
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
