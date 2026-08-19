import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const scriptPath = "scripts/testbed/ensure-testbed-pwsh.ps1";
const script = readFileSync(scriptPath, "utf8");

describe("testbed PowerShell cache bootstrap", () => {
  it("stages and validates a pending installation before replacing a damaged cache", () => {
    assert.match(
      script,
      /function Test-CachedPowerShell[\s\S]*\[string\] \$InstallRoot/,
    );
    assert.match(script, /\$pending = "\$root\.pending"/);
    assert.match(
      script,
      /Expand-Archive[\s\S]*Test-CachedPowerShell -InstallRoot \$pending/,
    );
    assert.match(
      script,
      /Move-Item -LiteralPath \$root -Destination \$previous[\s\S]*Move-Item -LiteralPath \$pending -Destination \$root/s,
    );
    assert.match(
      script,
      /Failed to replace PowerShell cache \(\$replacementError\) and restore the previous cache/,
    );
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath \$root -Recurse -Force -ErrorAction SilentlyContinue/,
    );
  });

  it("reuses a healthy cache without entering the download path", () => {
    assert.match(
      script,
      /if \(-not \(Test-CachedPowerShell -InstallRoot \$root\)\) \{[\s\S]*curl\.exe/s,
    );
    assert.match(
      script,
      /if \(-not \(Test-CachedPowerShell -InstallRoot \$root\)\) \{[\s\S]*\}\s*\n\s*if \(-not \(Test-CachedPowerShell -InstallRoot \$root\)\)/s,
    );
  });

  it("does not block proxy downloads on Windows revocation lookup", () => {
    assert.match(script, /curl\.exe[^\r\n]*--ssl-no-revoke/);
  });

  it("parses with the PowerShell AST parser", () => {
    execFileSync(
      process.env.PWSH ?? "pwsh",
      [
        "-NoProfile",
        "-Command",
        `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
      ],
      { stdio: "inherit" },
    );
  });
});
