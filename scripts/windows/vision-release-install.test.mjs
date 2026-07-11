import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const fixture = "scripts/windows/vision-release-install.fixtures.ps1";
const windowsHarness =
  "scripts/windows/vision-release-install.windows-harness.ps1";

describe("Vision release installer behavioral fixtures", () => {
  for (const testCase of [
    "archive",
    "bytes",
    "first-install",
    "acl",
    "task",
    "process-record",
    "protocol",
    "rollback",
    "orphan",
    "mutex",
    "reinstall",
    "runtime-verifier",
  ]) {
    it(`runs the ${testCase} fixture through PowerShell`, () => {
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-File", fixture, "-Case", testCase],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${testCase} fixtures passed`));
    });
  }

  it("parses as a production PowerShell entrypoint", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('scripts/windows/install-vision-release.ps1',[ref]$tokens,[ref]$errors)|Out-Null;if(@($errors).Count){$errors|% {Write-Error $_};exit 1}",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it("keeps trust roots outside update inputs and implements the real protocol/process-state boundary", () => {
    const result = spawnSync(
      "node",
      [
        "-e",
        "const fs=require('fs'); const s=fs.readFileSync('scripts/windows/install-vision-release.ps1','utf8'); const required=['FactoryTrustRoot','FactoryTrustPolicyPath','FactoryEvidenceVerifierPath','Assert-FactoryTrustAcl','process-state','ProcessStartInfo','ArgumentList.Add','vision.hello','vision.ready','Get-ExtractedFileManifest','Assert-InstalledRelease','Resolve-ApprovedVisionExecution','Quarantine-UntrustedReleaseDirectory','Get-CanonicalContainedPath','CON|PRN|AUX|NUL']; const forbidden=['[string]$TrustPolicyPath','[string]$EvidenceVerifierPath','FactoryTrustAnchorDigest']; for (const item of required) if (!s.includes(item)) throw new Error('missing '+item); for (const item of forbidden) if (s.includes(item)) throw new Error('mutable trust input '+item);",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it("passes the VEM provisioning root to the release provisioner", () => {
    const harness = readFileSync(windowsHarness, "utf8");
    assert.match(harness, /\$visionMediaRoot = Join-Path \$media "VEM"/);
    assert.match(
      harness,
      /provision-vision-factory-release\.ps1"\) -FactoryMediaRoot \$visionMediaRoot/,
    );
    assert.match(
      harness,
      /try\s*\{\s*& \(Join-Path \$installerMedia "provision-vision-factory-release\.ps1"\) -FactoryMediaRoot \$media\s*\}\s*catch\s*\{\s*\$wrongParentFailed = \$true\s*\}/s,
    );
    assert.match(
      harness,
      /Assert-True \$wrongParentFailed "Vision provisioner accepted the Factory Media parent instead of the VEM root"/,
    );
  });

  it("trusts and independently verifies the ephemeral Authenticode fixture", () => {
    const harness = readFileSync(windowsHarness, "utf8");
    const rootTrust = harness.indexOf(
      'CertStoreLocation "Cert:\\CurrentUser\\Root"',
    );
    const publisherTrust = harness.indexOf(
      'CertStoreLocation "Cert:\\CurrentUser\\TrustedPublisher"',
    );
    const sign = harness.indexOf("Set-AuthenticodeSignature");
    const verify = harness.indexOf("Get-AuthenticodeSignature");

    assert.notEqual(rootTrust, -1);
    assert.notEqual(publisherTrust, -1);
    assert.notEqual(sign, -1);
    assert.notEqual(verify, -1);
    assert.ok(rootTrust < publisherTrust);
    assert.ok(publisherTrust < sign);
    assert.ok(sign < verify);
    assert.match(harness, /fixture Authenticode status:/);
    assert.match(
      harness,
      /Remove-Item -LiteralPath \$trustedPublisherCertificate\.PSPath/,
    );
    assert.match(
      harness,
      /Remove-Item -LiteralPath \$trustedRootCertificate\.PSPath/,
    );
    assert.match(
      harness,
      /Remove-Item -LiteralPath \$certificate\.PSPath -DeleteKey/,
    );
  });
});
