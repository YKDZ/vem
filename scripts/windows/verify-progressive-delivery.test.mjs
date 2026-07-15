import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function root() {
  return mkdtempSync(join(tmpdir(), "vem-progressive-delivery-"));
}

test("verifier compares candidate identities against VM, managed-update, and Factory evidence", async () => {
  const dir = root();
  try {
    const daemon = `sha256:${"a".repeat(64)}`;
    const machine = `sha256:${"b".repeat(64)}`;
    const webview = `sha256:${"c".repeat(64)}`;
    const vision = `sha256:${"d".repeat(64)}`;
    const candidatePath = join(dir, "candidate.json");
    writeFileSync(
      candidatePath,
      `${JSON.stringify(
        {
          schemaVersion: "vem-unified-field-delivery/v1",
          kind: "unified-field-delivery",
          updateId: "field-20260715T120000Z",
          sourceCommit: "1".repeat(40),
          runtime: {
            artifacts: {
              "vem-daemon": { digest: daemon },
              "vem-machine-ui": { digest: machine },
              "webview2-loader": { digest: webview },
            },
          },
          vision: { bundleDigest: vision },
        },
        null,
        2,
      )}\n`,
    );
    const vmPath = join(dir, "vm.json");
    writeFileSync(
      vmPath,
      `${JSON.stringify({ artifacts: { daemonSha256: daemon.slice(7), machineUiSha256: machine.slice(7) } }, null, 2)}\n`,
    );
    const managedManifestPath = join(dir, "managed-update.json");
    writeFileSync(
      managedManifestPath,
      `${JSON.stringify(
        {
          updateId: "field-20260715T120000Z",
          sourceCommit: "1".repeat(40),
          components: [
            { component: "daemon", sha256: daemon.slice(7), targetPath: "C:\\VEM\\bringup\\vending-daemon.exe" },
            {
              component: "ui",
              sha256: machine.slice(7),
              targetPath: "C:\\VEM\\bringup\\machine.exe",
              sidecars: [
                { sha256: webview.slice(7), targetPath: "C:\\VEM\\bringup\\WebView2Loader.dll" },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const managedEvidencePath = join(dir, "managed-update-evidence.json");
    writeFileSync(
      managedEvidencePath,
      `${JSON.stringify({ sourceBinding: { schemaVersion: "managed-update-source-binding/v1" } }, null, 2)}\n`,
    );
    const factoryManifest = {
      schemaVersion: "vem-factory-manifest/v1",
      kind: "factory-manifest",
      manifestId: `sha256:${"f".repeat(64)}`,
      source: {
        windowsIso: {
          identity: `factory-cas://sha256/${"e".repeat(64)}`,
          digest: `sha256:${"e".repeat(64)}`,
          targetFirmware: "uefi",
          installImageEdition: "Professional",
        },
      },
      assets: [
        {
          role: "openssh-installer",
          identity: `factory-cas://sha256/${"f".repeat(64)}`,
          digest: `sha256:${"f".repeat(64)}`,
          version: "1.0.0",
          signature: { scheme: "authenticode-sha256", signerThumbprint: "A".repeat(40), rootThumbprint: "B".repeat(40), evidenceDigest: `sha256:${"1".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"1".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "2".repeat(64), evidenceDigest: `sha256:${"3".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"3".repeat(64)}` },
        },
        {
          role: "wireguard-installer",
          identity: `factory-cas://sha256/${"6".repeat(64)}`,
          digest: `sha256:${"6".repeat(64)}`,
          version: "1.0.0",
          signature: { scheme: "authenticode-sha256", signerThumbprint: "C".repeat(40), rootThumbprint: "D".repeat(40), evidenceDigest: `sha256:${"4".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"4".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "5".repeat(64), evidenceDigest: `sha256:${"6".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"6".repeat(64)}` },
        },
        {
          role: "vem-daemon",
          identity: `factory-cas://sha256/${daemon.slice(7)}`,
          digest: daemon,
          version: "1.0.0",
          signature: { scheme: "authenticode-sha256", signerThumbprint: "E".repeat(40), rootThumbprint: "F".repeat(40), evidenceDigest: `sha256:${"7".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"7".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "8".repeat(64), evidenceDigest: `sha256:${"9".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"9".repeat(64)}` },
        },
        {
          role: "vem-machine-ui",
          identity: `factory-cas://sha256/${machine.slice(7)}`,
          digest: machine,
          version: "1.0.0",
          signature: { scheme: "authenticode-sha256", signerThumbprint: "0".repeat(40), rootThumbprint: "1".repeat(40), evidenceDigest: `sha256:${"a".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"a".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "b".repeat(64), evidenceDigest: `sha256:${"c".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"c".repeat(64)}` },
        },
        {
          role: "webview2-loader",
          identity: `factory-cas://sha256/${webview.slice(7)}`,
          digest: webview,
          version: "1.0.0",
          signature: { scheme: "authenticode-sha256", signerThumbprint: "2".repeat(40), rootThumbprint: "3".repeat(40), evidenceDigest: `sha256:${"d".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"d".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "e".repeat(64), evidenceDigest: `sha256:${"f".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"f".repeat(64)}` },
        },
        {
          role: "vision-release",
          identity: `factory-cas://sha256/${vision.slice(7)}`,
          digest: vision,
          version: "1.0.0",
          signature: { scheme: "detached-ed25519", signerIdentity: "spki-sha256:" + "1".repeat(64), evidenceDigest: `sha256:${"2".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"2".repeat(64)}` },
          provenance: { predicateType: "https://slsa.dev/provenance/v1", sourceIdentity: "src", builderIdentity: "builder", buildId: "build", signerIdentity: "spki-sha256:" + "3".repeat(64), evidenceDigest: `sha256:${"4".repeat(64)}`, evidenceIdentity: `factory-evidence://sha256/${"4".repeat(64)}` },
          release: {
            descriptorIdentity: `factory-evidence://sha256/${"5".repeat(64)}`,
            descriptorDigest: `sha256:${"5".repeat(64)}`,
            attestationIdentity: `factory-evidence://sha256/${"6".repeat(64)}`,
            attestationDigest: `sha256:${"6".repeat(64)}`,
            approvalIdentity: `factory-evidence://sha256/${"7".repeat(64)}`,
            approvalDigest: `sha256:${"7".repeat(64)}`,
            conformanceEvidenceIdentity: `factory-evidence://sha256/${"8".repeat(64)}`,
            conformanceEvidenceDigest: `sha256:${"8".repeat(64)}`,
          },
        },
      ],
      profile: {
        profile: "testbed",
        maintenanceUser: "YKDZ",
      },
      factoryPreparation: {
        environmentName: "fixture",
        deploymentBatch: "fixture-batch",
        provisioningEndpoint: "http://127.0.0.1:26849/api",
        mqttUrl: "mqtt://127.0.0.1:1883",
        hardware: { mode: "simulated", model: "fixture", topologyIdentity: "fixture", topologyVersion: "1" },
        display: { width: 1080, height: 1920, orientation: "portrait" },
        accounts: { kioskUser: "VEMKiosk", maintenanceUser: "YKDZ", autoLogonUser: "VEMKiosk" },
        expectedKioskShell: "C:\\VEM\\bringup\\machine.exe",
        targetLayoutVersion: "win10-runtime-layout/v1",
        maintenance: {
          sshCaPublicKeySha256: "a".repeat(64),
          runnerSourceAllowlist: ["runner"],
          maintainerSourceAllowlist: ["maintainer"],
          wireGuardInterfaceAlias: "VEM-Maintenance",
          wireGuardListenAddress: "10.0.0.10",
        },
      },
    };
    const factoryManifestPath = join(dir, "factory-manifest.json");
    writeFileSync(factoryManifestPath, `${JSON.stringify(factoryManifest, null, 2)}\n`);
    const experimentalAcceptancePath = join(dir, "experimental-acceptance.json");
    writeFileSync(experimentalAcceptancePath, `${JSON.stringify({ bundleDigest: vision }, null, 2)}\n`);
    const script = join(process.cwd(), "scripts/windows/verify-progressive-delivery.mjs");
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(process.execPath, [
      script,
      "--candidate",
      candidatePath,
      "--vm-runtime-acceptance",
      vmPath,
      "--managed-update-manifest",
      managedManifestPath,
      "--managed-update-evidence",
      managedEvidencePath,
      "--factory-manifest",
      factoryManifestPath,
      "--experimental-acceptance",
      experimentalAcceptancePath,
    ]).toString("utf8");
    const report = JSON.parse(output);
    assert.equal(report.ok, true);
    assert.ok(report.checks.length >= 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
