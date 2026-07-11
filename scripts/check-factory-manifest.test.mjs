import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/build-factory-iso.yml";
const ciWorkflowPath = ".github/workflows/ci.yml";
const runtimeWorkflowPath =
  ".github/workflows/build-windows-runtime-artifacts.yml";

function read(path) {
  assert.equal(existsSync(path), true, `${path} should exist`);
  return readFileSync(path, "utf8");
}

describe("Factory Manifest and media workflow contract", () => {
  it("exposes a trusted manual trigger without caller-controlled factory inputs", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(parsed.on.workflow_dispatch, null);
    assert.equal(parsed.on.workflow_call, undefined);
    assert.doesNotMatch(
      workflow,
      /windows_source_iso|source_iso_path|private_key/i,
    );
  });

  it("gates restricted stores before trusted checkout on a protected labeled factory runner", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(parsed.jobs.build["runs-on"], [
      "self-hosted",
      "Linux",
      "X64",
      "vem-factory",
    ]);
    assert.equal(parsed.jobs.build.environment, "vem-factory-production");
    assert.deepEqual(parsed.jobs.build.needs, [
      "trust-gate",
      "build-runtime-artifacts",
    ]);
    assert.equal(parsed.jobs["build-runtime-artifacts"].needs, "trust-gate");
    assert.match(workflow, /workflow_dispatch\) ;;/);
    assert.match(workflow, /refs\/heads\/main\|refs\/tags\/factory-v\*/);
    assert.match(workflow, /GITHUB_ACTOR.*GITHUB_REPOSITORY_OWNER/);
    assert.match(workflow, /VEM_FACTORY_TRUSTED_RUNNER_NAME/);
    assert.match(workflow, /VEM_FACTORY_MANIFEST_IDENTITY/);
    assert.doesNotMatch(workflow, /inputs\.manifest_identity/);
    const firstBuildStep = parsed.jobs.build.steps[0];
    assert.match(firstBuildStep.name, /Guard Protected Factory Runner/);
    assert.doesNotMatch(
      JSON.stringify(parsed.jobs.build.env),
      /VEM_FACTORY_.*STORE/,
    );
    assert.doesNotMatch(workflow, /\$\{\{\s*vars\.VEM_FACTORY_/);
    assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
    for (const name of [
      "VEM_FACTORY_VISION_RELEASE_DELIVERY_UNIT",
      "VEM_FACTORY_REPOSITORY_VISION_TRUSTED_ROOTS",
      "VEM_FACTORY_FACTORY_VISION_TRUSTED_ROOTS",
      "VEM_FACTORY_VISION_EVIDENCE_VERIFIER",
    ]) {
      assert.match(workflow, new RegExp(name));
    }
  });

  it("executes manifest-pinned tools offline and uploads only validated bounded JSON evidence", () => {
    const workflow = read(workflowPath);
    assert.match(workflow, /VEM_FACTORY_EXECUTED_BUILDER_IMAGE/);
    assert.match(workflow, /VEM_FACTORY_ISO_BUILDER_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_VERSION/);
    assert.match(workflow, /VEM_FACTORY_AUTHENTICODE_VERIFIER_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_AUTHENTICODE_CA_BUNDLE/);
    assert.match(workflow, /docker run --rm --network none --read-only/);
    assert.match(workflow, /--vision-release-delivery-unit/);
    assert.match(workflow, /--repository-vision-trusted-roots/);
    assert.match(workflow, /--factory-vision-trusted-roots/);
    assert.match(workflow, /--vision-evidence-verifier/);
    assert.match(workflow, /--wimlib/);
    assert.match(workflow, /sanitize-build-evidence\.mjs/);
    const uploadStart = workflow.indexOf(
      "- name: Upload Sanitized Factory Evidence Only",
    );
    const upload = workflow.slice(
      uploadStart,
      workflow.indexOf("- name: Remove Ephemeral", uploadStart),
    );
    assert.match(upload, /factory-provenance\.json/);
    assert.match(upload, /factory-build-result\.json/);
    assert.doesNotMatch(upload, /\.iso|windows-source|cache/i);
  });

  it("installs exact xorriso and wimtools versions before required Factory media tests", () => {
    const workflow = read(ciWorkflowPath);
    assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
    assert.match(workflow, /xorriso=1:1\.5\.6-1\.1ubuntu3/);
    assert.match(workflow, /wimtools=1\.14\.4-1\.1build2/);
    for (const path of [
      "scripts/factory/build-factory-media.test.mjs",
      "scripts/factory/factory-cli.test.mjs",
    ]) {
      assert.doesNotMatch(read(path), /\bskip\b/);
    }
  });

  it("binds reusable runtime outputs and exact build toolchain into artifact identity", () => {
    const workflow = read(runtimeWorkflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(Object.keys(parsed.on.workflow_call.outputs).sort(), [
      "artifact_identity",
      "artifact_name",
      "commit",
      "workflow_run_identity",
    ]);
    assert.equal(parsed.jobs.build["runs-on"], "windows-2022");
    assert.match(workflow, /node-version:\s*24\.16\.0/);
    assert.match(workflow, /toolchain:\s*1\.96\.0/);
    assert.match(workflow, /pnpm exec tauri build/);
    assert.doesNotMatch(workflow, /pnpm dlx|@tauri-apps\/cli@\^/);
    assert.match(workflow, /runtime-artifact-descriptor\.mjs/);
    assert.match(workflow, /runnerImageVersion/);
    assert.match(workflow, /workflow_run_identity=/);
    assert.doesNotMatch(workflow, /Format-Table FullName|RUNNER_NAME/);
    assert.equal(
      JSON.parse(read("apps/machine/package.json")).devDependencies[
        "@tauri-apps/cli"
      ],
      "2.11.4",
    );
  });
});
