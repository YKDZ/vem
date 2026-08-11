import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const descriptorPath = new URL(
  "../trusted-gh-cli-linux-amd64.json",
  import.meta.url,
);

test("tracked GitHub CLI descriptor binds the official 2.95.0 Linux binary", () => {
  const raw = readFileSync(descriptorPath, "utf8");
  const descriptor = JSON.parse(raw);
  assert.equal(raw, `${JSON.stringify(descriptor, null, 2)}\n`);
  assert.deepEqual(descriptor, {
    archive: {
      byteSize: 14642738,
      expandedByteSize: 41068365,
      memberCount: 231,
      sha256:
        "25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c",
      url: "https://github.com/cli/cli/releases/download/v2.95.0/gh_2.95.0_linux_amd64.tar.gz",
    },
    binary: {
      byteSize: 40702114,
      relativeMember: "gh_2.95.0_linux_amd64/bin/gh",
      sha256:
        "62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617",
      versionOutput:
        "gh version 2.95.0 (2026-06-17)\nhttps://github.com/cli/cli/releases/tag/v2.95.0\n",
    },
    platform: "linux-amd64",
    schemaVersion: "vem.trusted-gh-cli.v1",
    version: "2.95.0",
  });
  const verified = spawnSync(
    "python3",
    [
      "scripts/materialize_trusted_gh.py",
      "verify-binary",
      "--descriptor",
      descriptorPath.pathname,
      "--gh-binary",
      "/usr/bin/gh",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /TRUSTED_GH_BINARY=PASS/);
});

test("trusted attester materializes the pinned CLI at one absolute path", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/trusted-release-set-attester.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /scripts\/materialize_trusted_gh\.py materialize/);
  assert.match(workflow, /trusted-gh-cli-linux-amd64\.json/);
  assert.match(workflow, /--destination \/opt\/vem-trusted-gh/);
  assert.match(workflow, /\/opt\/vem-trusted-gh\/gh --version/);
  assert.doesNotMatch(workflow, /(^|\s)gh\s+/m);
});
