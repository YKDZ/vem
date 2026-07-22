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

test("run-full resolves commit via D:\\runtime-cache\\v1\\vision-main index first", () => {
  const contents = source();
  assert.match(
    contents,
    /\$visionCommit = Get-ResolvedVisionMainCommit -CacheRoot \$visionCacheRoot[\s\S]*Get-VisionMainArtifactCache -CacheRoot \$visionCacheRoot -CommitSha \$visionCommit/s,
  );
});

test("run-full always tears down its Vision task and verifies port 7892 is reusable", () => {
  const contents = source();
  assert.match(
    contents,
    /function Stop-ManagedVision\(\) \{[\s\S]*Stop-ScheduledTask[\s\S]*Get-Process -Name "vending-vision"/s,
  );
  assert.match(
    contents,
    /try \{[\s\S]*Install-VisionMainArtifact[\s\S]*vision-try-on-acceptance\.mjs[\s\S]*\} finally \{[\s\S]*Stop-ManagedVision[\s\S]*Wait-ForVisionPortRebind/s,
  );
  assert.match(
    contents,
    /function Wait-ForVisionPortRebind\(\[int\]\$TimeoutSeconds = \d+\)[\s\S]*\[DateTime\]::UtcNow\.AddSeconds\(\$TimeoutSeconds\)[\s\S]*\[Net\.Sockets\.TcpListener\]::new\(\[Net\.IPAddress\]::Loopback, 7892\)/s,
  );
});

test("run-full keeps the business failure when Vision cleanup also fails", () => {
  const contents = source();
  assert.match(
    contents,
    /catch \{[\s\S]*\$primaryFailure = \$_[\s\S]*throw[\s\S]*finally \{[\s\S]*catch \{[\s\S]*if \(\$null -ne \$primaryFailure\) \{[\s\S]*Write-Warning/s,
  );
});

test("psm1 prefers cache-first when CommitSha is provided", () => {
  const psm1 = moduleText("../windows/vision-main-artifacts.psm1");
  assert.match(
    psm1,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$CommitSha\)\) \{[\s\S]*Assert-VisionCachedArtifacts \$cacheDirectory \$commit/s,
  );
});
