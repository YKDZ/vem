import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("含非 ASCII 文本的 Windows PowerShell 5.1 模块带 UTF-8 BOM", () => {
  const moduleBytes = readFileSync(
    "scripts/testbed/recorded-video-fixture-decision.psm1",
  );

  assert.equal(
    moduleBytes.subarray(3).some((byte) => byte > 0x7f),
    true,
  );
  assert.deepEqual([...moduleBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

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
