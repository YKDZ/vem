import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runFullPath = "./run-full-vision-try-on-track.ps1";

function source() {
  return readFileSync(new URL(runFullPath, import.meta.url), "utf8");
}

function moduleText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("run-full uses fixed VEMKiosk task user for Vision install", () => {
  const contents = source();
  assert.match(contents, /-TaskUser "VEMKiosk"/);
});

test("run-full emits origins accepted by the managed Vision schema", () => {
  const contents = source();
  assert.match(contents, /"http:\/\/tauri\.localhost"/);
  assert.doesNotMatch(contents, /"https:\/\/tauri\.localhost"/);
});

test("run-full loops recorded cameras so cold model start does not exhaust the VM frame source", () => {
  const contents = source();
  assert.equal(contents.match(/loop = \$false/g)?.length, undefined);
  assert.equal(contents.match(/loop = \$true/g)?.length, 2);
});

test("run-full resolves commit via D:\\runtime-cache\\v1\\vision-main index first", () => {
  const contents = source();
  assert.match(
    contents,
    /\$visionCommit = Get-ResolvedVisionMainCommit -CacheRoot \$visionCacheRoot[\s\S]*Get-VisionMainArtifactCache -CacheRoot \$visionCacheRoot -CommitSha \$visionCommit/s,
  );
});

test("run-full only stops the task-owned Vision executable and verifies port 7892 is reusable", () => {
  const contents = source();
  assert.match(
    contents,
    /function Get-ManagedVisionTasks\(\) \{[\s\S]*Get-ScheduledTask[\s\S]*TaskName -in @\("VEMVisionRuntime", "StartVisionServer"\)/s,
  );
  assert.doesNotMatch(
    contents,
    /Get-ScheduledTask -TaskName \$taskName -TaskPath "\\VEM\\"/,
  );
  assert.match(
    contents,
    /function Stop-ManagedVision\(\) \{[\s\S]*foreach \(\$task in @\(Get-ManagedVisionTasks\)\)[\s\S]*Stop-ScheduledTask -InputObject \$task[\s\S]*foreach \(\$processId in @\(Get-ManagedVisionProcessIds\)\)[\s\S]*try \{ & taskkill\.exe \/PID \(\[int\]\$processId\) \/T \/F \*>\s*\$null \} catch \{ \}[\s\S]*Stop-Process -Id \(\[int\]\$processId\)/s,
  );
  assert.doesNotMatch(contents, /Get-Process -Name "vending-vision"/);
  assert.match(
    contents,
    /try \{[\s\S]*Get-VisionMainArtifactCache[\s\S]*Write-RecordedVisionSiteConfiguration[\s\S]*Install-VisionMainArtifact[\s\S]*vision-try-on-acceptance\.mjs[\s\S]*\} finally \{[\s\S]*Stop-ManagedVision[\s\S]*Wait-ForVisionPortRebind/s,
  );
  assert.match(
    contents,
    /function Wait-ForVisionPortRebind\(\[int\]\$TimeoutSeconds = \d+\)[\s\S]*\[DateTime\]::UtcNow\.AddSeconds\(\$TimeoutSeconds\)[\s\S]*\[Net\.Sockets\.TcpListener\]::new\(\[Net\.IPAddress\]::Loopback, 7892\)/s,
  );
});

test("run-full keeps the business failure and still probes 7892 when Vision stop fails", () => {
  const contents = source();
  assert.match(
    contents,
    /catch \{[\s\S]*\$primaryFailure = \$_[\s\S]*throw[\s\S]*finally \{[\s\S]*Stop-ManagedVision[\s\S]*catch \{[\s\S]*\$cleanupFailures \+= \$_[\s\S]*Wait-ForVisionPortRebind[\s\S]*catch \{[\s\S]*\$cleanupFailures \+= \$_[\s\S]*if \(\$null -ne \$primaryFailure\) \{[\s\S]*Write-Warning/s,
  );
});

test("psm1 prefers cache-first when CommitSha is provided", () => {
  const psm1 = moduleText("../windows/vision-main-artifacts.psm1");
  assert.match(
    psm1,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$CommitSha\)\) \{[\s\S]*Assert-VisionCachedArtifacts \$cacheDirectory \$commit/s,
  );
});
