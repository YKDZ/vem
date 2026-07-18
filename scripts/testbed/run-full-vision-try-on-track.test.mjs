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

test("run-full resolves commit via D:\\runtime-cache\\v1\\vision-main index first", () => {
  const contents = source();
  assert.match(
    contents,
    /\$visionCommit = Get-ResolvedVisionMainCommit -CacheRoot \$visionCacheRoot[\s\S]*Get-VisionMainArtifactCache -CacheRoot \$visionCacheRoot -CommitSha \$visionCommit/s,
  );
});

test("psm1 prefers cache-first when CommitSha is provided", () => {
  const psm1 = moduleText("../windows/vision-main-artifacts.psm1");
  assert.match(
    psm1,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$CommitSha\)\) \{[\s\S]*Assert-VisionCachedArtifacts \$cacheDirectory \$commit/s,
  );
});
