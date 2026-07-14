import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { factoryOobePrivacySuppressionScript } from "./factory/oobe-registry.mjs";

test(
  "OOBE privacy writes preserve existing registry content and create missing keys",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-oobe-registry-"));
    const scriptPath = join(directory, "verify-oobe-registry.ps1");
    const testRoot = `HKCU:\\Software\\VEM\\Tests\\${randomUUID()}`;
    const existingPolicy = `${testRoot}\\ExistingPolicy`;
    const existingState = `${testRoot}\\ExistingState`;
    const missingPolicy = `${testRoot}\\Missing\\Policy`;
    const missingState = `${testRoot}\\Missing\\State`;
    const script = `$ErrorActionPreference = 'Stop'
$testRoot = '${testRoot}'
try {
  New-Item -Path '${existingPolicy}\\NativePlugin' -Force | Out-Null
  New-ItemProperty -Path '${existingPolicy}' -Name Sentinel -Value 'policy' -PropertyType String -Force | Out-Null
  New-Item -Path '${existingState}\\NativePlugin' -Force | Out-Null
  New-ItemProperty -Path '${existingState}' -Name Sentinel -Value 'state' -PropertyType String -Force | Out-Null
${factoryOobePrivacySuppressionScript({ policyPath: existingPolicy, statePath: existingState })}
  if (-not (Test-Path -LiteralPath '${existingPolicy}\\NativePlugin' -PathType Container)) { throw 'existing policy child was removed' }
  if ((Get-ItemPropertyValue -LiteralPath '${existingPolicy}' -Name Sentinel) -cne 'policy') { throw 'existing policy value changed' }
  if (-not (Test-Path -LiteralPath '${existingState}\\NativePlugin' -PathType Container)) { throw 'existing state child was removed' }
  if ((Get-ItemPropertyValue -LiteralPath '${existingState}' -Name Sentinel) -cne 'state') { throw 'existing state value changed' }
  if ((Get-ItemPropertyValue -LiteralPath '${existingPolicy}' -Name DisablePrivacyExperience) -ne 1) { throw 'policy DWORD was not set' }
  if ((Get-ItemPropertyValue -LiteralPath '${existingState}' -Name PrivacyConsentStatus) -ne 1) { throw 'state DWORD was not set' }
${factoryOobePrivacySuppressionScript({ policyPath: missingPolicy, statePath: missingState })}
  foreach ($assertion in @(
    @{ Path = '${missingPolicy}'; Name = 'DisablePrivacyExperience' },
    @{ Path = '${missingState}'; Name = 'PrivacyConsentStatus' }
  )) {
    if (-not (Test-Path -LiteralPath $assertion.Path -PathType Container)) { throw "missing registry key was not created: $($assertion.Path)" }
    $property = Get-ItemProperty -LiteralPath $assertion.Path -Name $assertion.Name
    if ($property.($assertion.Name) -ne 1) { throw "registry value was not set: $($assertion.Name)" }
    if ((Get-Item -LiteralPath $assertion.Path).GetValueKind($assertion.Name) -ne [Microsoft.Win32.RegistryValueKind]::DWord) { throw "registry value type is not DWORD: $($assertion.Name)" }
  }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}`;
    try {
      writeFileSync(scriptPath, script, "utf8");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
