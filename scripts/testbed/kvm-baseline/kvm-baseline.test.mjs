import assert from "node:assert/strict";
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

import { buildWin10Baseline } from "./build-win10-baseline.mjs";
import {
  createRuntimeProfile,
  renderLibvirtDomainXml,
} from "./libvirt-runtime-profile.mjs";
import {
  evaluateHostPreflight,
  promoteVerifiedBaseline,
  validateBaselineBuildConfig,
} from "./linux-kvm-baseline.mjs";

function buildConfig(root) {
  return {
    schemaVersion: "win10-kvm-baseline/v1",
    host: {
      address: "kvm-builder.example.test",
      libvirtUri: "qemu:///system",
    },
    vm: {
      name: "win10-runtime-baseline",
      networkName: "runtime-testbed",
      guestAddress: "192.0.2.44",
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
      registrationTokenFile: join(root, "secrets", "runner-token"),
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

    const xml = renderLibvirtDomainXml(profile);
    assert.match(xml, /<memory unit="MiB">16384<\/memory>/);
    assert.match(xml, /<model type="qxl" ram="65536"/);
    assert.match(xml, /target type="usb-serial" port="0"/);
    assert.match(xml, /alias name="serial-scanner"/);
    assert.match(xml, /<sound model="ich9"\/>/);
    assert.doesNotMatch(xml, /192\.168\.2\.22|\/mnt\/user|Unraid/i);
  });

  it("requires caller-owned identity, storage, media, network, and runner inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-kvm-baseline-config-"));
    try {
      const config = buildConfig(root);
      assert.deepEqual(validateBaselineBuildConfig(config), config);

      delete config.runner.registrationTokenFile;
      assert.throws(
        () => validateBaselineBuildConfig(config),
        /runner\.registrationTokenFile/,
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
            ],
            cpuCount: 32,
            availableMemoryMiB: 64 * 1024,
            availableStorageBytes: 200 * 1024 ** 3,
            installationMedia: { windowsIso: true },
            networkAvailable: true,
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
            ],
            cpuCount: 8,
            availableMemoryMiB: 16 * 1024,
            availableStorageBytes: 79 * 1024 ** 3,
            installationMedia: { windowsIso: true },
            networkAvailable: true,
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
          ],
          cpuCount: 8,
          availableMemoryMiB: 16 * 1024,
          availableStorageBytes: 80 * 1024 ** 3,
          installationMedia: { windowsIso: true },
          networkAvailable: true,
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

    assert.match(shared, /WebView2/);
    assert.match(shared, /PlugPlay/);
    assert.match(shared, /W32Time/);
    assert.doesNotMatch(shared, /config\.cmd|actions-runner|choco install/i);
    assert.match(runtime, /config\.cmd/);
    assert.match(runtime, /choco install/i);
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
  });

  it("has an independent manual workflow that never uploads a baseline image", () => {
    const workflow = readFileSync(
      ".github/workflows/build-win10-kvm-baseline.yml",
      "utf8",
    );
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /build-win10-baseline\.mjs/);
    assert.doesNotMatch(
      workflow,
      /upload-artifact|scripts\/factory|build-factory-iso/i,
    );
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
