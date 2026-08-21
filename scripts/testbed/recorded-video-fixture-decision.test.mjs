import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("录播夹具路径与配置决策的 PowerShell 5.1 语法子集 seam", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/testbed/recorded-video-fixture-decision.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
});
