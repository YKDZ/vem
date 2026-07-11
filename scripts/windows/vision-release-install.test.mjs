import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const fixture = "scripts/windows/vision-release-install.fixtures.ps1";
const windowsHarness =
  "scripts/windows/vision-release-install.windows-harness.ps1";
const ciWorkflow = ".github/workflows/ci.yml";
const SPAWN_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;

function boundedIt(name, options, fn) {
  if (typeof options === "function") {
    return it(name, { timeout: TEST_TIMEOUT_MS }, options);
  }
  return it(name, { ...options, timeout: TEST_TIMEOUT_MS }, fn);
}

function spawnBounded(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
    ...options,
  });
  assert.notEqual(
    result.error?.code,
    "ETIMEDOUT",
    `${command} exceeded ${SPAWN_TIMEOUT_MS}ms`,
  );
  return result;
}

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
    boundedIt(`runs the ${testCase} fixture through PowerShell`, () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-File",
        fixture,
        "-Case",
        testCase,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${testCase} fixtures passed`));
    });
  }

  boundedIt("parses as a production PowerShell entrypoint", () => {
    const result = spawnBounded("pwsh", [
      "-NoProfile",
      "-Command",
      "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('scripts/windows/install-vision-release.ps1',[ref]$tokens,[ref]$errors)|Out-Null;if(@($errors).Count){$errors|% {Write-Error $_};exit 1}",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  boundedIt("parses the Windows harness library seam", () => {
    const result = spawnBounded("pwsh", [
      "-NoProfile",
      "-Command",
      "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('scripts/windows/vision-release-install.windows-harness.ps1',[ref]$tokens,[ref]$errors)|Out-Null;if(@($errors).Count){$errors|% {Write-Error $_};exit 1}",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  boundedIt(
    "keeps trust roots outside update inputs and implements the real protocol/process-state boundary",
    () => {
      const result = spawnBounded("node", [
        "-e",
        "const fs=require('fs'); const s=fs.readFileSync('scripts/windows/install-vision-release.ps1','utf8'); const required=['FactoryTrustRoot','FactoryTrustPolicyPath','FactoryEvidenceVerifierPath','Assert-FactoryTrustAcl','process-state','ProcessStartInfo','ArgumentList.Add','vision.hello','vision.ready','Get-ExtractedFileManifest','Assert-InstalledRelease','Resolve-ApprovedVisionExecution','Quarantine-UntrustedReleaseDirectory','Get-CanonicalContainedPath','CON|PRN|AUX|NUL']; const forbidden=['[string]$TrustPolicyPath','[string]$EvidenceVerifierPath','FactoryTrustAnchorDigest']; for (const item of required) if (!s.includes(item)) throw new Error('missing '+item); for (const item of forbidden) if (s.includes(item)) throw new Error('mutable trust input '+item);",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "passes the VEM provisioning root to the release provisioner",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      assert.match(harness, /\$visionMediaRoot = Join-Path \$media "VEM"/);
      assert.match(
        harness,
        /provision-vision-factory-release\.ps1"\) -FactoryMediaRoot \$context\.visionMediaRoot/,
      );
      assert.match(
        harness,
        /try\s*\{\s*& \(Join-Path \$context\.installerMedia "provision-vision-factory-release\.ps1"\) -FactoryMediaRoot \$context\.media\s*\}\s*catch\s*\{\s*\$wrongParentFailed = \$true\s*\}/s,
      );
      assert.match(
        harness,
        /Assert-True \$wrongParentFailed "Vision provisioner accepted the Factory Media parent instead of the VEM root"/,
      );
    },
  );

  boundedIt(
    "trusts and independently verifies the ephemeral Authenticode fixture",
    () => {
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
      assert.match(harness, /function Remove-HarnessFixtureCertificates/);
      assert.match(harness, /Cert:\\CurrentUser\\My/);
      assert.match(harness, /Cert:\\CurrentUser\\Root/);
      assert.match(harness, /Cert:\\CurrentUser\\TrustedPublisher/);
      assert.match(harness, /\.Subject -eq \$CertificateSubject/);
      assert.match(harness, /-DeleteKey/);
    },
  );

  boundedIt(
    "bounds every harness operation with visible telemetry and .NET process-tree termination",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      const stopRuntime = harness.slice(
        harness.indexOf("function Stop-HarnessFixtureRuntime"),
        harness.indexOf("function Invoke-BoundedPowerShell"),
      );
      const requiredStages = [
        "fixture.cleanup",
        "fixture.compile-runtime",
        "fixture.compile-verifier",
        "fixture.create-certificate",
        "fixture.export-certificate",
        "fixture.trust-root",
        "fixture.trust-publisher",
        "fixture.sign-runtime",
        "fixture.verify-authenticode",
        "fixture.assemble-release",
        "fixture.provision-and-first-install",
        "fixture.activation-regressions",
        "fixture.process-mutex-runtime",
        "fixture.cleanup-certificates",
      ];

      assert.match(harness, /function Write-HarnessStage/);
      assert.match(harness, /\[DateTime\]::UtcNow\.ToString\("o"\)/);
      assert.match(harness, /Write-Host \$message/);
      assert.match(harness, /function Invoke-BoundedPowerShell/);
      assert.match(harness, /\$process\.Kill\(\$true\)/);
      assert.match(harness, /\$process\.HasExited/);
      assert.match(harness, /WaitForExit\(\$terminationWaitMilliseconds\)/);
      assert.doesNotMatch(harness, /taskkill\.exe/);
      assert.match(harness, /-NoProfile.*-NonInteractive/s);
      assert.match(harness, /return \[pscustomobject\]@\{ stdout=/);
      assert.match(harness, /\$HarnessDeadlineSeconds = 480/);
      assert.match(harness, /\$CleanupReserveSeconds = 75/);
      assert.match(harness, /-TimeoutSeconds 45/);
      assert.doesNotMatch(harness, /Get-Process runtime/);
      assert.match(harness, /function Stop-HarnessFixtureRuntime/);
      assert.match(harness, /function Invoke-HarnessFixtureCleanup/);
      assert.match(
        harness,
        /\$writeHarnessStageFunction = \$\{function:Write-HarnessStage\}\.ToString\(\)/,
      );
      assert.match(
        harness,
        /function Write-HarnessStage \{\s*\$writeHarnessStageFunction\s*\}/s,
      );
      assert.match(
        harness,
        /\[string\]\$selection\.bundleDigest -cne \[string\]\$Context\.bundleDigest/,
      );
      assert.match(
        harness,
        /\$process\.StartTime\.ToUniversalTime\(\)\.ToString\("o"\)/,
      );
      assert.match(
        harness,
        /\(Get-Digest \$process\.Path\) -cne \$expectedDigest/,
      );
      assert.match(stopRuntime, /\$process -isnot \[Diagnostics\.Process\]/);
      assert.match(stopRuntime, /\$process\.Kill\(\$true\)/);
      assert.match(stopRuntime, /\$process\.WaitForExit\(5000\)/);
      assert.doesNotMatch(stopRuntime, /Stop-Process/);
      assert.ok(
        stopRuntime.indexOf("(Get-Digest $process.Path)") <
          stopRuntime.lastIndexOf("Stop-ScheduledTask"),
        "runtime path, digest, and start time must be verified before stopping the task",
      );
      assert.match(harness, /Invoke-HarnessFixtureCleanup -Context \$context/);
      assert.match(
        harness,
        /function Invoke-HarnessFixtureCleanup \{[\s\S]*?\$runtimeCleaned = \$false\s*try \{\s*\$runtimeCleaned = Stop-HarnessFixtureRuntime -Context \$Context\s*\} finally \{[\s\S]*?Remove-HarnessFixtureCertificates/s,
      );
      assert.match(harness, /if \(-not \$runtimeCleaned\) \{ throw/);
      for (const stage of requiredStages) {
        assert.match(harness, new RegExp(`-Stage "${stage}"`));
      }
      for (const call of harness.matchAll(
        /Invoke-BoundedPowerShell -Stage [^\n]+/g,
      )) {
        assert.match(call[0], /-HarnessDeadlineUtc \$harnessDeadlineUtc/);
      }
    },
  );

  boundedIt(
    "executes the serialized cleanup function set and stops the verified process handle",
    () => {
      const root = mkdtempSync(join(tmpdir(), "vem-vision-cleanup-test-"));
      const contextPath = join(root, "context.json");
      writeFileSync(
        contextPath,
        JSON.stringify({ root, stateRoot: root }),
        "utf8",
      );
      const escapedRoot = root.replaceAll("'", "''");
      const escapedContextPath = contextPath.replaceAll("'", "''");
      const command = [
        `$root = '${escapedRoot}'`,
        `$contextPath = '${escapedContextPath}'`,
        `. '${windowsHarness}' -Library`,
        "$deadline = [DateTime]::UtcNow.AddSeconds(20)",
        '$serialized = Invoke-BoundedPowerShell -Stage \'test.serialized-cleanup\' -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath (Get-Command pwsh).Source -HarnessDeadlineUtc $deadline -ScriptBody \'Write-HarnessStage "test.serialized-cleanup" "loaded"; Write-Json (Join-Path $context.root "fixture-certificate-cleanup.json") @{ certificateSubject = "fixture" }; function Stop-HarnessFixtureRuntime { throw "simulated runtime cleanup failure" }; function Remove-HarnessFixtureCertificates { param([string]$CertificateSubject) [IO.File]::WriteAllText((Join-Path $context.root "certificate-cleanup-ran"), $CertificateSubject) }; try { Invoke-HarnessFixtureCleanup -Context $context; throw "serialized cleanup did not report runtime failure" } catch { if (-not (Test-Path -LiteralPath (Join-Path $context.root "certificate-cleanup-ran"))) { throw "serialized certificate cleanup did not run from finally" } }\'',
        "if ($serialized.stdout -notmatch 'stage=test.serialized-cleanup status=loaded') { throw 'serialized cleanup did not load Write-HarnessStage' }",
        "$operation = Get-Content -LiteralPath (Join-Path $serialized.diagnosticsPath 'operation.ps1') -Raw",
        "foreach ($name in 'Write-HarnessStage','Remove-HarnessFixtureCertificates','Stop-HarnessFixtureRuntime','Invoke-HarnessFixtureCleanup') { if ($operation -notmatch ('function ' + $name)) { throw \"serialized cleanup omitted $name\" } }",
        "if ((Get-Content -LiteralPath (Join-Path $root 'certificate-cleanup-ran') -Raw) -ne 'fixture') { throw 'serialized certificate cleanup did not preserve its marker subject' }",
        "$script:taskStopped = $false",
        "function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) $script:taskStopped = $true }",
        "$process = Start-Process -FilePath (Get-Command sleep).Source -ArgumentList '60' -PassThru",
        "try {",
        "$metadataPath = Join-Path $root 'metadata.json'",
        "$processStateDirectory = Join-Path $root 'process-state'",
        "New-Item -ItemType Directory -Force -Path $processStateDirectory | Out-Null",
        "$expectedPath = [IO.Path]::GetFullPath($process.Path)",
        "$digest = Get-Digest $process.Path",
        "Write-Json $metadataPath @{ entrypointDigest = $digest }",
        "Write-Json (Join-Path $root 'current.json') @{ schemaVersion = 'vem-vision-selection/v1'; bundleDigest = 'sha256:fixture'; revision = 'fixture-revision'; metadataPath = $metadataPath; installDirectory = (Split-Path -Parent $expectedPath); entrypoint = (Split-Path -Leaf $expectedPath) }",
        "Write-Json (Join-Path $processStateDirectory 'active-process.json') @{ bundleDigest = 'sha256:fixture'; selectionRevision = 'fixture-revision'; processId = $process.Id; creationTimeUtc = $process.StartTime.ToUniversalTime().ToString('o'); executablePath = $expectedPath; executableDigest = $digest }",
        "if (-not (Stop-HarnessFixtureRuntime -Context ([pscustomobject]@{ stateRoot = $root; bundleDigest = 'sha256:fixture' }))) { throw 'verified runtime cleanup failed' }",
        "if (-not $script:taskStopped) { throw 'verified runtime cleanup did not stop its task' }",
        "if (-not $process.HasExited) { throw 'verified runtime process remained alive' }",
        "if (Test-Path -LiteralPath (Join-Path $processStateDirectory 'active-process.json')) { throw 'verified runtime record remained' }",
        "} finally { if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) }; $process.Dispose() }",
      ].join("\n");

      try {
        const result = spawnBounded("pwsh", [
          "-NoProfile",
          "-Command",
          command,
        ]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(
          result.stdout,
          /stage=test\.serialized-cleanup status=started/,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  boundedIt(
    "persists an exact per-run certificate cleanup marker before certificate mutation",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      const marker = harness.indexOf("fixture-certificate-cleanup.json");
      const create = harness.indexOf('Stage "fixture.create-certificate"');

      assert.ok(marker >= 0, "certificate cleanup marker is missing");
      assert.ok(create >= 0, "certificate creation stage is missing");
      assert.ok(
        marker < create,
        "certificate marker must precede certificate creation",
      );
      assert.match(harness, /certificateSubject=/);
      assert.match(harness, /certificateThumbprint=\$null/);
      assert.match(
        harness,
        /certificateThumbprint=\[string\]\$certificate\.thumbprint/,
      );
      assert.match(harness, /fixture\.cleanup-certificates/);
    },
  );

  boundedIt(
    "keeps timeout telemetry visible through Out-Null, returns one result object, and cleans exact fixture certificates",
    { skip: process.platform !== "win32" },
    () => {
      const root = mkdtempSync(join(tmpdir(), "vem-vision-harness-test-"));
      const contextPath = join(root, "context.json");
      const certificateSubject = `CN=VEM Vision Harness Test ${crypto.randomUUID()}`;
      writeFileSync(contextPath, JSON.stringify({ root }), "utf8");
      const command = [
        `$root = '${root.replaceAll("'", "''")}'`,
        `$contextPath = '${contextPath.replaceAll("'", "''")}'`,
        `$certificateSubject = '${certificateSubject.replaceAll("'", "''")}'`,
        `. '${windowsHarness}' -Library`,
        "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
        "$descendantPidPath = Join-Path $root 'descendant.pid'",
        "$unrelated = Start-Process -FilePath \"$env:WINDIR\\System32\\cmd.exe\" -ArgumentList '/d', '/c', 'ping -n 60 127.0.0.1 > nul' -PassThru",
        "try {",
        "$result = Invoke-BoundedPowerShell -Stage 'test.return' -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath (Get-Command pwsh).Source -HarnessDeadlineUtc $deadline -ScriptBody 'Write-Output child-output' | Out-Null",
        "if ($null -ne $result) { throw 'Out-Null did not suppress the returned result' }",
        "$returned = Invoke-BoundedPowerShell -Stage 'test.object' -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath (Get-Command pwsh).Source -HarnessDeadlineUtc $deadline -ScriptBody 'Write-Output child-output'",
        "if (@($returned).Count -ne 1 -or $returned.stdout.Trim() -ne 'child-output' -or $returned.PSObject.Properties.Name -join ',' -ne 'stdout,stderr,diagnosticsPath') { throw 'bounded invocation did not return exactly its result object' }",
        "$timeoutBody = @'",
        "$descendant = Start-Process -FilePath \"$env:WINDIR\\System32\\cmd.exe\" -ArgumentList '/d', '/c', 'ping -n 60 127.0.0.1 > nul' -PassThru",
        "[IO.File]::WriteAllText((Join-Path $context.root 'descendant.pid'), [string]$descendant.Id, [Text.UTF8Encoding]::new($false))",
        "Start-Sleep -Seconds 30",
        "'@",
        "try { Invoke-BoundedPowerShell -Stage 'test.timeout' -TimeoutSeconds 1 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath (Get-Command pwsh).Source -HarnessDeadlineUtc $deadline -ScriptBody $timeoutBody | Out-Null; throw 'timeout did not throw' } catch { if ($_.Exception.Message -notmatch 'exceeded') { throw } }",
        "if (-not (Test-Path -LiteralPath $descendantPidPath)) { throw 'timeout stage did not record its descendant PID' }",
        "$descendantPid = [int](Get-Content -LiteralPath $descendantPidPath -Raw)",
        "Start-Sleep -Milliseconds 250",
        "if (Get-Process -Id $descendantPid -ErrorAction SilentlyContinue) { throw 'timed-out stage left its descendant process alive' }",
        "if ($unrelated.HasExited) { throw 'timed-out stage stopped an unrelated process' }",
        "try {",
        "$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certificateSubject -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\\CurrentUser\\My'",
        "$certificatePath = Join-Path $root 'certificate.cer'",
        "Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null",
        "Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\\CurrentUser\\Root' | Out-Null",
        "Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\\CurrentUser\\TrustedPublisher' | Out-Null",
        "} finally {",
        "Remove-HarnessFixtureCertificates -CertificateSubject $certificateSubject",
        "foreach ($store in 'Cert:\\CurrentUser\\My','Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\TrustedPublisher') { if (Get-ChildItem -Path $store | Where-Object Subject -eq $certificateSubject) { throw \"fixture certificate remained after cleanup in $store\" } }",
        "}",
        "} finally {",
        "foreach ($processId in @($descendantPid, $unrelated.Id)) { if ($processId) { $process = Get-Process -Id $processId -ErrorAction SilentlyContinue; if ($process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } } }",
        "}",
      ].join("\n");

      try {
        const result = spawnBounded("pwsh", [
          "-NoProfile",
          "-Command",
          command,
        ]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /stage=test.return status=started/);
        assert.match(result.stdout, /stage=test.timeout status=timed-out/);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  boundedIt(
    "uses the pinned Windows image and a sub-ten-minute Vision job budget",
    () => {
      const workflow = readFileSync(ciWorkflow, "utf8");
      const visionJob = workflow.match(
        /windows-vision-release-installer:([\s\S]*?)(?=\n  [a-z0-9-]+:|$)/,
      )?.[1];

      assert.ok(visionJob, "Windows Vision installer job is missing");
      assert.match(visionJob, /runs-on: windows-2022/);
      assert.match(visionJob, /timeout-minutes: 10/);
      assert.match(visionJob, /uses: actions\/setup-node@v6/);
      assert.match(visionJob, /node-version: 24/);
      assert.match(visionJob, /run: pnpm check:vision-release-installer/);
      assert.ok(
        visionJob.indexOf("pnpm check:vision-release-installer") <
          visionJob.indexOf("vision-release-install.windows-harness.ps1"),
        "behavioral checks must run before the full Windows harness",
      );
    },
  );

  boundedIt(
    "runs the behavioral guard through package test and static CI",
    () => {
      const packageJson = readFileSync("package.json", "utf8");
      const ciRunner = readFileSync("tools/check-ci.mjs", "utf8");

      assert.match(
        packageJson,
        /"test":\s*"[^"\n]*vision-release-install\.test\.mjs/,
      );
      assert.match(
        packageJson,
        /"check:vision-release-installer":\s*"[^"\n]*vision-release-install\.test\.mjs/,
      );
      assert.match(
        ciRunner,
        /run\("pnpm", \["check:vision-release-installer"\]\)/,
      );
      const source = readFileSync(new URL(import.meta.url), "utf8");
      assert.match(source, /const SPAWN_TIMEOUT_MS = 45_000/);
      assert.match(source, /const TEST_TIMEOUT_MS = 60_000/);
      assert.match(source, /timeout: SPAWN_TIMEOUT_MS/);
      assert.match(source, /timeout: TEST_TIMEOUT_MS/);
    },
  );
});
