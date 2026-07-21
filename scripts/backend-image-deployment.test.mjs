import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deploymentRecord,
  validateCommit as validateDeployCommit,
} from "./deploy-backend-stack.mjs";
import {
  imageNames,
  registryBuildArgs,
  validateCommit as validatePublishCommit,
} from "./publish-backend-images.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("backend image publishing", () => {
  it("requires a full lowercase commit and derives sha tags", () => {
    assert.equal(validatePublishCommit(commit), commit);
    assert.deepEqual(imageNames("registry.example/", commit), [
      `registry.example/vem-service-api:sha-${commit}`,
      `registry.example/vem-admin-ui:sha-${commit}`,
    ]);
    assert.throws(
      () => validatePublishCommit(commit.slice(0, -1)),
      /40-character/,
    );
    assert.throws(
      () => validatePublishCommit(commit.toUpperCase()),
      /40-character/,
    );
  });

  it("passes an explicitly configured package registry to BuildKit", () => {
    assert.deepEqual(
      registryBuildArgs({ NPM_CONFIG_REGISTRY: "https://registry.test/" }),
      ["--build-arg", "NPM_CONFIG_REGISTRY=https://registry.test/"],
    );
    assert.deepEqual(registryBuildArgs({}), []);
  });
});

describe("backend deployment record", () => {
  it("records the requested commit and repository digests", () => {
    const record = deploymentRecord({
      commit,
      configured: {
        serviceApi: `registry/vem-service-api:sha-${commit}`,
        adminUi: `registry/vem-admin-ui:sha-${commit}`,
      },
      repoDigests: {
        serviceApi: "registry/vem-service-api@sha256:a",
        adminUi: "registry/vem-admin-ui@sha256:b",
      },
      composeFile: "/compose.yml",
      envFile: "/env",
      digestOverride: "/override.yml",
      deployedAt: "2026-07-21T00:00:00.000Z",
    });
    assert.equal(validateDeployCommit(record.requestedCommit), commit);
    assert.deepEqual(record.repoDigests, {
      serviceApi: "registry/vem-service-api@sha256:a",
      adminUi: "registry/vem-admin-ui@sha256:b",
    });
  });
});
