import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function matchesWorkflowSemver(pattern, version) {
  try {
    execFileSync(
      "bash",
      ["-c", '[[ "$1" =~ $2 ]]', "factory-tool-semver", version, pattern],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
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
    assert.equal(parsed.jobs.build.needs, "trust-gate");
    assert.match(workflow, /workflow_dispatch\) ;;/);
    assert.match(workflow, /refs\/heads\/main\|refs\/tags\/factory-v\*/);
    assert.match(workflow, /GITHUB_ACTOR.*GITHUB_REPOSITORY_OWNER/);
    assert.match(workflow, /VEM_FACTORY_TRUSTED_RUNNER_NAME/);
    assert.match(workflow, /VEM_FACTORY_MANIFEST_IDENTITY/);
    assert.doesNotMatch(workflow, /inputs\.manifest_identity/);
    const firstBuildStep = parsed.jobs.build.steps[0];
    assert.match(firstBuildStep.name, /Guard Protected Factory Runner/);
    assert.equal(
      firstBuildStep.env.RUNNER_LABELS_JSON,
      '["self-hosted","Linux","X64","vem-factory"]',
    );
    assert.doesNotMatch(
      JSON.stringify(parsed.jobs.build.env ?? {}),
      /VEM_FACTORY_.*STORE/,
    );
    assert.doesNotMatch(workflow, /\$\{\{\s*vars\.VEM_FACTORY_/);
    assert.doesNotMatch(workflow, /runner\.labels/);
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
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_VERSION/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_VERSION/);
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
    assert.match(workflow, /--udf-extractor/);
    assert.match(workflow, /--udf-writer/);
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

  it("accepts only strict Factory Manifest SemVer forms for pinned tools", () => {
    const parsed = parse(read(workflowPath));
    const guard = parsed.jobs.build.steps[0].run;
    const pattern = guard.match(/^\s*factory_tool_semver='([^']+)'$/m)?.[1];
    assert.ok(pattern, "Factory runner guard defines the tool SemVer pattern");
    assert.match(guard, /\[\[ "\$version" =~ \$factory_tool_semver \]\]/);
    for (const version of [
      "0.0.0",
      "1.14.4-1.1build2",
      "1.2.3-alpha.1+build.7",
      "1.2.3+build.7",
    ]) {
      assert.equal(matchesWorkflowSemver(pattern, version), true, version);
    }
    for (const version of [
      "1.2",
      "01.2.3",
      "1.2.3-01",
      "1.2.3+build..7",
      "1.2.3-",
      "not-a-version",
    ]) {
      assert.equal(matchesWorkflowSemver(pattern, version), false, version);
    }
  });

  it("uses a validated Docker reference while preserving the OCI builder identity", () => {
    const parsed = parse(read(workflowPath));
    const buildStep = parsed.jobs.build.steps.find(
      ({ name }) => name === "Build Through Manifest-Pinned Offline Toolchain",
    );
    assert.ok(
      buildStep,
      "Factory build workflow has an offline toolchain step",
    );
    const script = buildStep.run;
    assert.match(script, /\[\[ "\$docker_builder_image" =~ \^\[a-z0-9\]/);
    assert.match(
      script,
      /docker_builder_image="\$\{VEM_FACTORY_BUILDER_IMAGE#oci:\/\/\}"/,
    );
    assert.match(
      script,
      /\[\[ "\$docker_builder_image" != "\$VEM_FACTORY_BUILDER_IMAGE" \]\]/,
    );
    assert.match(script, /docker pull "\$docker_builder_image"/);
    assert.match(
      script,
      /--env "VEM_FACTORY_EXECUTED_BUILDER_IMAGE=\$VEM_FACTORY_BUILDER_IMAGE"/,
    );
    assert.match(
      script,
      /"\$docker_builder_image" \\\n\s+node \/workspace\/scripts\/factory\/factory-cli\.mjs/,
    );
    assert.doesNotMatch(script, /docker pull "\$VEM_FACTORY_BUILDER_IMAGE"/);
  });

  it("consumes host-published Factory Manifest and CAS inputs without a runtime artifact handoff", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.equal(parsed.jobs["build-runtime-artifacts"], undefined);
    assert.equal(parsed.jobs.build.needs, "trust-gate");
    assert.equal(parsed.jobs.build.env, undefined);
    assert.doesNotMatch(
      workflow,
      /build-windows-runtime-artifacts|build-runtime-artifacts|RUNTIME_ARTIFACT|vem-runtime-artifacts|import-runtime-artifacts|actions\/download-artifact/,
    );
  });

  it("runs Factory media tests in the tracked builder image", () => {
    const workflow = read(ciWorkflowPath);
    assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
    assert.match(
      workflow,
      /docker build\s+\\\n\s+--file scripts\/factory\/Dockerfile/,
    );
    assert.match(workflow, /Run Factory Media Contract Tests In Builder/);
    assert.match(workflow, /docker run --rm/);
    assert.match(workflow, /--env HOME=\/tmp/);
    assert.match(workflow, /--user "\$\(id -u\):\$\(id -g\)"/);
    assert.match(
      workflow,
      /VEM_FACTORY_TEST_UDF_WRITER=\/usr\/bin\/genisoimage/,
    );
    assert.match(workflow, /sha256sum \/usr\/bin\/genisoimage/);
    assert.match(
      read("scripts/factory/build-factory-media.test.mjs"),
      /fixture genisoimage digest must match the pinned contract/,
    );
    assert.doesNotMatch(workflow, /Install Factory Media Fixture Tools/);
    assert.doesNotMatch(workflow, /apt-cache policy genisoimage/);
    assert.doesNotMatch(
      workflow,
      /VEM_FACTORY_TEST_UDF_WRITER_DIGEST: sha256:/,
    );
    assert.match(
      read("scripts/factory/build-factory-media.test.mjs"),
      /skip: !process\.env\.VEM_FACTORY_REAL_WINDOWS_ISO/,
    );
    assert.doesNotMatch(
      read("scripts/factory/factory-builder-definition.test.mjs"),
      /skip:/,
    );
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
