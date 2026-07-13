import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const composePath = "apps/service-api/compose.maintenance-ssh-ca.example.yaml";
const externalSecretVariable =
  "${VEM_MAINTENANCE_SSH_CA_SECRET_FILE:?Set an external Maintenance SSH CA secret path}";
const externalTargetPolicyVariable =
  "${VEM_MAINTENANCE_SSH_TARGET_POLICY_FILE:?Set an external SSH target policy path}";

describe("Maintenance SSH CA secret boundaries", () => {
  it("requires an external compose source and ignores every secrets directory", () => {
    const compose = parse(readFileSync(composePath, "utf8"));
    assert.equal(
      compose.secrets.maintenance_ssh_ca_testbed.file,
      externalSecretVariable,
    );
    assert.doesNotMatch(
      compose.secrets.maintenance_ssh_ca_testbed.file,
      /^\.?\.?\//,
    );
    assert.equal(
      compose.configs.maintenance_ssh_target_policy_testbed.file,
      externalTargetPolicyVariable,
    );
    assert.doesNotMatch(
      compose.configs.maintenance_ssh_target_policy_testbed.file,
      /^\.?\.?\//,
    );

    const gitIgnore = readFileSync(".gitignore", "utf8");
    const dockerIgnore = readFileSync(".dockerignore", "utf8");
    assert.match(gitIgnore, /^secrets\/$/m);
    assert.match(gitIgnore, /^\*\*\/secrets\/$/m);
    assert.match(dockerIgnore, /^secrets$/m);
    assert.match(dockerIgnore, /^\*\*\/secrets$/m);
    assert.match(dockerIgnore, /^\*\*\/secrets\/\*\*$/m);
  });

  it("finds no tracked secret directory or complete OpenSSH private key", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(
      tracked.filter((path) => path.split("/").includes("secrets")),
      [],
    );

    const leakedKeys = tracked.filter((path) => {
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        return false;
      }
      return /-----BEGIN OPENSSH PRIVATE KEY-----\s+[A-Za-z0-9+/]{40,}/.test(
        content,
      );
    });
    assert.deepEqual(leakedKeys, []);
  });

  it("excludes root and nested secrets from the real Docker build context", () => {
    const fixtures = [
      "secrets/issue06-context-leak",
      "apps/service-api/secrets/issue06-context-leak",
    ];
    try {
      for (const fixture of fixtures) {
        mkdirSync(fixture.slice(0, fixture.lastIndexOf("/")), {
          recursive: true,
        });
        writeFileSync(fixture, "must-not-enter-build-context\n", {
          mode: 0o600,
        });
        const probe = spawnSync(
          "docker",
          ["build", "--progress=plain", "--no-cache", "--file", "-", "."],
          {
            encoding: "utf8",
            input: `FROM scratch\nCOPY ${fixture} /context-leak\n`,
          },
        );
        assert.notEqual(
          probe.status,
          0,
          `${fixture} unexpectedly entered the Docker build context`,
        );
        assert.match(
          `${probe.stdout}${probe.stderr}`,
          /not found|excluded by \.dockerignore|failed to calculate checksum/i,
        );
      }
    } finally {
      rmSync("secrets", { recursive: true, force: true });
      rmSync("apps/service-api/secrets", { recursive: true, force: true });
    }
  });
});
