import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const runner = join(
  repoRoot,
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
);

test("AI virtual try-on runner fails closed without emitting acceptance evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-track-placeholder-"));
  const output = join(root, "ai-virtual-try-on.json");
  try {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        runner,
        "-GuestInputPath",
        join(root, "guest-input.json"),
        "-HandoffPath",
        join(root, "handoff.json"),
        "-OutPath",
        output,
        "-FixtureKey",
        "aiVirtualTryOn",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /AI virtual try-on acceptance is not implemented/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
